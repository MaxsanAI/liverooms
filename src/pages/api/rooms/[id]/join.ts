import type { APIRoute } from "astro";

type Env = {
  DB?: D1Database;
  REALTIMEKIT_API_TOKEN?: string;
  REALTIMEKIT_ACCOUNT_ID?: string;
  REALTIMEKIT_APP_ID?: string;
};

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

export const POST: APIRoute = async ({ params, request, locals }) => {
  const roomId = params.id;
  const runtime = (locals as { runtime?: { env?: Env } }).runtime;
  const env = runtime?.env;

  if (!roomId) return json({ error: "Room ID is required." }, 400);

  const db = env?.DB;
  if (!db) return json({ error: "D1 database is not connected yet." }, 503);

  const apiToken = env?.REALTIMEKIT_API_TOKEN;
  const accountId = env?.REALTIMEKIT_ACCOUNT_ID;
  const appId = env?.REALTIMEKIT_APP_ID || "60ea49e3-ee6f-46f0-81ff-b1d2c9d16414";

  if (!apiToken || !accountId) {
    return json({
      error: "RealtimeKit is not configured yet. Add REALTIMEKIT_API_TOKEN and REALTIMEKIT_ACCOUNT_ID in Cloudflare."
    }, 503);
  }

  const room = await db.prepare(`
    SELECT id, title, description, host_id, realtime_meeting_id, status
    FROM rooms
    WHERE id = ?
    LIMIT 1
  `).bind(roomId).first<{
    id: string;
    title: string;
    description: string | null;
    host_id: string | null;
    realtime_meeting_id: string | null;
    status: string;
  }>();

  if (!room) return json({ error: "Room not found." }, 404);

  let body: {
    participantId?: string;
    name?: string;
    role?: "host" | "listener";
  } = {};

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }

  const participantId = body.participantId?.trim() || crypto.randomUUID();
  const name = body.name?.trim().slice(0, 80) || "Guest";
  const isHost = body.role === "host" && room.host_id === participantId;
  const role = isHost ? "host" : "listener";
  const presetName = role === "host" ? "group_call_host" : "group_call_participant";

  let meetingId = room.realtime_meeting_id;

  try {
    if (!meetingId) {
      const meetingResponse = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/kit/${appId}/meetings`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ title: room.title })
        }
      );

      const meetingPayload = await meetingResponse.json() as {
        success?: boolean;
        result?: { id?: string };
      };

      if (!meetingResponse.ok || !meetingPayload.result?.id) {
        return json({ error: "Could not create the realtime meeting." }, 502);
      }

      meetingId = meetingPayload.result.id;

      await db.prepare(`
        UPDATE rooms
        SET realtime_meeting_id = ?, status = 'live'
        WHERE id = ?
      `).bind(meetingId, roomId).run();
    }

    const participantResponse = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/kit/${appId}/meetings/${meetingId}/participants`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name,
          preset_name: presetName,
          custom_participant_id: participantId
        })
      }
    );

    const participantPayload = await participantResponse.json() as {
      success?: boolean;
      result?: {
        id?: string;
        token?: string;
      };
    };

    if (!participantResponse.ok || !participantPayload.result?.token) {
      return json({ error: "Could not create the room participant." }, 502);
    }

    await db.prepare(`
      INSERT OR REPLACE INTO room_participants (room_id, user_id, role)
      VALUES (?, ?, ?)
    `).bind(roomId, participantId, role).run();

    return json({
      roomId,
      meetingId,
      participantId,
      role,
      token: participantPayload.result.token
    });
  } catch {
    return json({ error: "RealtimeKit connection failed." }, 502);
  }
};
