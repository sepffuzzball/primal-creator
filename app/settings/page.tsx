"use client"

import { useTheme } from "next-themes"
import { LogOutIcon, ShieldIcon, UserIcon } from "lucide-react"

import { AppShell, useAppShell } from "@/components/app-shell"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export default function SettingsPage() {
  return (
    <AppShell breadcrumbs={[{ label: "Settings" }]}>
      <SettingsContent />
    </AppShell>
  )
}

function SettingsContent() {
  const { user, logout } = useAppShell()
  const { resolvedTheme, setTheme } = useTheme()

  if (!user) return null

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-lg font-medium">Settings</h1>
        <p className="text-xs text-muted-foreground">
          Account and appearance preferences.
        </p>
      </div>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Your signed-in identity.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <UserIcon className="size-4 text-muted-foreground" />
              <span className="font-medium">{user.email}</span>
              {user.isAdmin ? (
                <Badge>
                  <ShieldIcon className="mr-0.5 size-3" />
                  Admin
                </Badge>
              ) : null}
            </div>
            <div className="text-xs text-muted-foreground">
              User id: <span className="font-mono">{user.id}</span>
            </div>
            <div>
              <Button variant="outline" className="gap-1" onClick={logout}>
                <LogOutIcon />
                Log out
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Choose how the app is displayed.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Button
              variant={resolvedTheme === "dark" ? "default" : "outline"}
              size="sm"
              onClick={() => setTheme("dark")}
            >
              Dark
            </Button>
            <Button
              variant={resolvedTheme === "light" ? "default" : "outline"}
              size="sm"
              onClick={() => setTheme("light")}
            >
              Light
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
