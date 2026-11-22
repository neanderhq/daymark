import { NextResponse, type NextRequest } from 'next/server';

// Better Auth protects its own routes. Public booking/poll endpoints are intentionally anonymous.
export function proxy(request: NextRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    || request.nextUrl.pathname.startsWith('/api/public/')
    || request.nextUrl.pathname.startsWith('/api/auth/')) return NextResponse.next();
  const expected = new URL(process.env.BETTER_AUTH_URL || 'http://localhost:3000').origin;
  if (request.headers.get('origin') !== expected) {
    return NextResponse.json({ error: 'Request origin rejected.' }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: '/api/:path*' };
