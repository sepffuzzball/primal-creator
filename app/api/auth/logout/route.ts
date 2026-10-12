import { NextResponse } from "next/server"
import { SESSION_COOKIE, cookieOptions } from "@/lib/auth/session"
import { respond } from "@/lib/server/errors"

export const runtime = "nodejs"

export async function POST() {
  return respond(async () => {
    const res = NextResponse.json({ ok: true })
    res.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 })
    return res
  })
}
