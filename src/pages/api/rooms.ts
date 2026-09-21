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

export const GET: APIRoute = async ({ locals }) => {
  const runtime = (locals as { runtime?: { env?: Env } }).runtime;
  const db = runtime?.env?.DB;

  if (!db) {
    return json({ error: "D1 database is not connected yet.", rooms: [] }, 503);
  }

  const result = await db.prepare(`
    SELECT
      r.id,
      r.title,
      r.description,
      r.category,
      r.language,
      r.status,
      r.created_at,
      r.host_id,
      COALESCE(u.display_name, 'Anonymous Host') AS host_name,
      COALESCE((SELECT COUNT(*) FROM room_participants rp WHERE rp.room_id = r.id), 0) AS listener_count
    FROM rooms r
    LEFT JOIN users u ON u.id = r.host_id
    WHERE r.status IN ('live', 'scheduled')
    ORDER BY
      CASE WHEN r.status = 'live' THEN 0 ELSE 1 END,
      r.created_at DESC
    LIMIT 50
  `).all();

  return json({ rooms: result.results ?? [] });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const runtime = (locals as { runtime?: { env?: Env } }).runtime;
  const db = runtime?.env?.DB;

  if (!db) {
    return json({ error: "D1 database is not connected yet." }, 503);
  }

  let body: {
    title?: string;
    description?: string;
    category?: string;
    language?: string;
  };

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }

  const title = body.title?.trim();
  if (!title || title.length < 3 || title.length > 120) {
    return json({ error: "Title must be between 3 and 120 characters." }, 400);
  }

  const id = crypto.randomUUID();
  const description = body.description?.trim().slice(0, 500) || null;
  const category = body.category?.trim().slice(0, 60) || "General";
  const language = body.language?.trim().slice(0, 10) || "en";

  await db.prepare(`
    INSERT INTO rooms (id, title, description, category, language, status)
    VALUES (?, ?, ?, ?, ?, 'scheduled')
  `).bind(id, title, description, category, language).run();

  return json({
    room: { id, title, description, category, language, status: "scheduled" }
  }, 201);
};
