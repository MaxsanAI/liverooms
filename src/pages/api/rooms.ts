import type { APIRoute } from "astro";

type Env = {
  DB?: D1Database;
};

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const runtime = (locals as { runtime?: { env?: Env } }).runtime;
  const db = runtime?.env?.DB;

  if (!db) {
    return new Response(JSON.stringify({
      error: "D1 database is not connected yet.",
      rooms: []
    }), {
      status: 503,
      headers: { "content-type": "application/json" }
    });
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

  return new Response(JSON.stringify({ rooms: result.results ?? [] }), {
    headers: { "content-type": "application/json" }
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const runtime = (locals as { runtime?: { env?: Env } }).runtime;
  const db = runtime?.env?.DB;

  if (!db) {
    return new Response(JSON.stringify({ error: "D1 database is not connected yet." }), {
      status: 503,
      headers: { "content-type": "application/json" }
    });
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
    return new Response(JSON.stringify({ error: "Invalid JSON." }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  const title = body.title?.trim();
  if (!title || title.length < 3 || title.length > 120) {
    return new Response(JSON.stringify({ error: "Title must be between 3 and 120 characters." }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  const id = crypto.randomUUID();
  const description = body.description?.trim().slice(0, 500) || null;
  const category = body.category?.trim().slice(0, 60) || "General";
  const language = body.language?.trim().slice(0, 10) || "en";

  await db.prepare(`
    INSERT INTO rooms (id, title, description, category, language, status)
    VALUES (?, ?, ?, ?, ?, 'scheduled')
  `).bind(id, title, description, category, language).run();

  return new Response(JSON.stringify({
    room: { id, title, description, category, language, status: "scheduled" }
  }), {
    status: 201,
    headers: { "content-type": "application/json" }
  });
};
