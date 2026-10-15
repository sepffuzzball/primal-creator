"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { SparklesIcon } from "lucide-react"

import { apiFetch, ApiError, jsonInit, type LoginResponse } from "@/lib/api"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    let active = true
    apiFetch<LoginResponse>("/api/auth/me")
      .then(() => {
        if (active) router.replace("/")
      })
      .catch(() => {
        // Not authenticated; stay on the login screen.
      })
    return () => {
      active = false
    }
  }, [router])

  const onSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setError(null)
      setSubmitting(true)
      try {
        await apiFetch<LoginResponse>("/api/auth/login", {
          ...jsonInit("POST", { email, password }),
        })
        router.replace("/")
        router.refresh()
      } catch (err) {
        if (err instanceof ApiError) {
          setError(err.message)
        } else {
          setError("Could not reach the server.")
        }
      } finally {
        setSubmitting(false)
      }
    },
    [email, password, router]
  )

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <div className="fixed top-3 right-3">
        <ThemeToggle />
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <SparklesIcon className="size-5 text-primary" />
              <CardTitle className="font-heading text-base">
                The Primal Creator
              </CardTitle>
            </div>
            <p className="text-xs text-muted-foreground">
              Sign in to manage your characters.
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {error ? (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <Button type="submit" disabled={submitting}>
                {submitting ? "Signing in..." : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
