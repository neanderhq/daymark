// Database-backed passwords are no longer a sign-in path for Neander clones.
export function GET() { return Response.json({ error: "Use managed sign-in." }, { status: 404 }); }
export function POST() { return Response.json({ error: "Use managed sign-in." }, { status: 404 }); }
