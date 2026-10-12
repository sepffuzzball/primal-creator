import { NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import { prisma } from "@/lib/db/client"
import { loginSchema } from "@/lib/server/schemas"
import {
  SESSION_COOKIE,
  cookieOptions,
  createSessionToken,
} from "@/lib/auth/session"
import { badRequest, respond, unauthorized } from "@/lib/server/errors"

export const runtime = "nodejs"

export async function POST(req: Request) {
  return respond(async () => {
    const body = await req.json().catch(() => null)
    const parsed = loginSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest("validation", "Invalid email or password")
    }
    const { email, password } = parsed.data
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    })
    const valid =
      user != null && (await bcrypt.compare(password, user.password))
    if (!valid) {
      throw unauthorized("invalid_credentials", "Invalid email or password")
    }
    const token = await createSessionToken({
      id: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
    })
    const res = NextResponse.json({
      user: { id: user.id, email: user.email, isAdmin: user.isAdmin },
    })
    res.cookies.set(SESSION_COOKIE, token, cookieOptions())
    return res
  })
}
