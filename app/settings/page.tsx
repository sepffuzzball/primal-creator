"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import {
  BanIcon,
  CircleCheckIcon,
  KeyRoundIcon,
  LogOutIcon,
  RefreshCwIcon,
  ShieldIcon,
  ShieldPlusIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
  UserIcon,
  UserPlusIcon,
} from "lucide-react"
import { toast } from "sonner"

import {
  apiFetch,
  ApiError,
  jsonInit,
  type AdminHouseRulesConfig,
  type AdminHouseRulesResponse,
  type AdminUser,
  type AdminUserResponse,
  type AdminUsersResponse,
  type HouseRulesPatchRequest,
  type PasswordChangeResponse,
} from "@/lib/api"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

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
          Account, security and administrative preferences.
        </p>
      </div>

      <AccountCard onLogout={logout} />

      <ChangePasswordCard />

      {user.isAdmin ? <AdminUsersCard /> : null}

      {user.isAdmin ? <HouseRulesCard /> : null}

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

function AccountCard({ onLogout }: { onLogout: () => Promise<void> }) {
  const { user } = useAppShell()
  if (!user) return null
  return (
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
            <Button variant="outline" className="gap-1" onClick={onLogout}>
              <LogOutIcon />
              Log out
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function ChangePasswordCard() {
  const { refreshUser } = useAppShell()
  const [currentPassword, setCurrentPassword] = React.useState("")
  const [newPassword, setNewPassword] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  const onSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setSubmitting(true)
      try {
        await apiFetch<PasswordChangeResponse>("/api/auth/password", {
          ...jsonInit("POST", { currentPassword, newPassword }),
        })
        toast.success("Password updated. Other sessions were signed out.")
        // Clear passwords: they must never be kept around after submission.
        setCurrentPassword("")
        setNewPassword("")
        await refreshUser()
      } catch (err) {
        toast.error(
          err instanceof ApiError
            ? err.message
            : "Could not change the password."
        )
      } finally {
        setSubmitting(false)
      }
    },
    [currentPassword, newPassword, refreshUser]
  )

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>
          Requires at least 12 characters and must differ from your current
          password. Changing it signs out every other session immediately.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div>
            <Button type="submit" disabled={submitting}>
              <KeyRoundIcon />
              {submitting ? "Updating..." : "Update password"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function AdminUsersCard() {
  const [users, setUsers] = React.useState<AdminUser[]>([])
  const [loading, setLoading] = React.useState(true)

  const [newEmail, setNewEmail] = React.useState("")
  const [newPassword, setNewPassword] = React.useState("")
  const [newIsAdmin, setNewIsAdmin] = React.useState(false)
  const [creating, setCreating] = React.useState(false)

  const [resetTarget, setResetTarget] = React.useState<AdminUser | null>(null)
  const [resetPassword, setResetPassword] = React.useState("")
  const [resetting, setResetting] = React.useState(false)

  const reload = React.useCallback(async () => {
    try {
      const res = await apiFetch<AdminUsersResponse>("/api/admin/users")
      setUsers(res.users)
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Could not load users."
      )
    }
  }, [])

  // Initial load. The setState calls are deferred to the promise callbacks so a
  // synchronous setState never runs inside the effect body.
  React.useEffect(() => {
    let active = true
    apiFetch<AdminUsersResponse>("/api/admin/users")
      .then((res) => {
        if (active) setUsers(res.users)
      })
      .catch((err) => {
        if (active) {
          toast.error(
            err instanceof ApiError ? err.message : "Could not load users."
          )
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  // Returns true only when the PATCH succeeded; callers use it to decide whether
  // to take follow-up UI actions (e.g. close the reset-password dialog).
  const patchUser = React.useCallback(
    async (
      id: string,
      patch: Record<string, unknown>,
      message: string
    ): Promise<boolean> => {
      try {
        const res = await apiFetch<AdminUserResponse>(
          `/api/admin/users/${id}`,
          jsonInit("PATCH", patch)
        )
        setUsers((prev) => prev.map((u) => (u.id === id ? res.user : u)))
        toast.success(message)
        return true
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : "Update failed.")
        return false
      }
    },
    []
  )

  const onCreate = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setCreating(true)
      try {
        await apiFetch<AdminUserResponse>("/api/admin/users", {
          ...jsonInit("POST", {
            email: newEmail,
            password: newPassword,
            ...(newIsAdmin ? { isAdmin: true } : {}),
          }),
        })
        toast.success(`Created account for "${newEmail}".`)
        setNewEmail("")
        setNewPassword("")
        setNewIsAdmin(false)
        await reload()
      } catch (err) {
        toast.error(
          err instanceof ApiError ? err.message : "Could not create user."
        )
      } finally {
        setCreating(false)
      }
    },
    [newEmail, newPassword, newIsAdmin, reload]
  )

  const onReset = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!resetTarget) return
      setResetting(true)
      try {
        const ok = await patchUser(
          resetTarget.id,
          { password: resetPassword },
          `Password reset for "${resetTarget.email}". Their existing sessions were signed out.`
        )
        // Close the dialog only after the update actually succeeded; on a failure
        // the dialog stays open with the entered password so the admin can retry.
        if (ok) {
          setResetTarget(null)
          setResetPassword("")
        }
      } finally {
        setResetting(false)
      }
    },
    [resetTarget, resetPassword, patchUser]
  )

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Users</CardTitle>
        <CardDescription>
          Admin-managed accounts. There is no public registration - only you can
          create users.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-6">
          <form
            onSubmit={onCreate}
            className="grid gap-3 rounded-xl border border-dashed p-4"
          >
            <div className="text-xs font-medium text-muted-foreground">
              Create user
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-user-email">Email</Label>
                <Input
                  id="new-user-email"
                  type="email"
                  autoComplete="off"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-user-password">Password</Label>
                <Input
                  id="new-user-password"
                  type="password"
                  autoComplete="off"
                  required
                  minLength={12}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={newIsAdmin}
                  onChange={(e) => setNewIsAdmin(e.target.checked)}
                />
                Grant admin role
              </label>
              <Button
                type="submit"
                disabled={creating || !newEmail || !newPassword}
              >
                <UserPlusIcon />
                {creating ? "Creating..." : "Create"}
              </Button>
            </div>
          </form>

          {loading ? (
            <div className="text-xs text-muted-foreground">
              Loading users...
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {users.map((u) => (
                <li
                  key={u.id}
                  className="flex flex-col gap-2 rounded-lg border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <UserIcon className="size-4 text-muted-foreground" />
                    <span className="font-medium">{u.email}</span>
                    {u.isAdmin ? (
                      <Badge>
                        <ShieldIcon className="mr-0.5 size-3" />
                        Admin
                      </Badge>
                    ) : null}
                    {u.disabled ? (
                      <Badge variant="destructive">
                        <BanIcon className="mr-0.5 size-3" />
                        Disabled
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={u.disabled}
                      onClick={() =>
                        window.confirm(
                          u.isAdmin
                            ? `Demote "${u.email}" to a regular user?`
                            : `Promote "${u.email}" to admin?`
                        ) &&
                        patchUser(
                          u.id,
                          { isAdmin: !u.isAdmin },
                          u.isAdmin
                            ? `Demoted "${u.email}".`
                            : `Promoted "${u.email}".`
                        )
                      }
                    >
                      <ShieldPlusIcon />
                      {u.isAdmin ? "Make regular" : "Make admin"}
                    </Button>
                    {u.disabled ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          patchUser(
                            u.id,
                            { disabled: false },
                            `Enabled "${u.email}".`
                          )
                        }
                      >
                        <CircleCheckIcon />
                        Enable
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          window.confirm(
                            `Disable "${u.email}"? Their session is revoked immediately.`
                          ) &&
                          patchUser(
                            u.id,
                            { disabled: true },
                            `Disabled "${u.email}".`
                          )
                        }
                      >
                        <BanIcon />
                        Disable
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setResetTarget(u)}
                    >
                      <RefreshCwIcon />
                      Reset password
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>

      <Dialog
        open={resetTarget != null}
        onOpenChange={(open) => {
          if (!open) {
            setResetTarget(null)
            setResetPassword("")
          }
        }}
      >
        {resetTarget ? (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reset password</DialogTitle>
              <DialogDescription>
                Set a new password for &quot;{resetTarget.email}&quot;. This
                signs out all of their existing sessions immediately.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={onReset} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reset-password">New password</Label>
                <Input
                  id="reset-password"
                  type="password"
                  autoComplete="off"
                  required
                  minLength={12}
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setResetTarget(null)
                    setResetPassword("")
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={resetting || !resetPassword}>
                  {resetting ? "Resetting..." : "Reset password"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </Card>
  )
}

/**
 * Admin-only house-rules editor for the single server-wide `house_rules` row.
 * GET/PATCH with an explicit CAS version: a stale PATCH is a 409 and the card
 * reloads the latest values (never silently clobbers an admin's concurrent edit).
 * Non-admin users never render this card at all.
 */
function HouseRulesCard() {
  const [config, setConfig] = React.useState<AdminHouseRulesConfig | null>(null)
  const [version, setVersion] = React.useState<number>(0)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)

  const applyResponse = React.useCallback((res: AdminHouseRulesResponse) => {
    setConfig(res.config)
    setVersion(res.version)
  }, [])

  const reload = React.useCallback(async () => {
    try {
      const res = await apiFetch<AdminHouseRulesResponse>("/api/admin/rules")
      applyResponse(res)
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Could not load house rules."
      )
    }
  }, [applyResponse])

  // Initial load. Deferred setState happens only inside the promise callbacks so
  // a synchronous setState never runs in the effect body.
  React.useEffect(() => {
    let active = true
    apiFetch<AdminHouseRulesResponse>("/api/admin/rules")
      .then((res) => {
        if (active) applyResponse(res)
      })
      .catch((err) => {
        if (active) {
          toast.error(
            err instanceof ApiError
              ? err.message
              : "Could not load house rules."
          )
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [applyResponse])

  const setPercent =
    (key: "equipmentIndividualCapPercent" | "equipmentCombinedCapPercent") =>
    (value: number) => {
      setConfig((prev) => (prev ? { ...prev, [key]: value } : prev))
    }

  const setGradeRate = (grade: "F" | "E" | "D" | "C") => (value: number) => {
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            consumableGradeRates: {
              ...prev.consumableGradeRates,
              [grade]: value,
            },
          }
        : prev
    )
  }

  const onSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!config) return
    setSaving(true)
    try {
      const body: HouseRulesPatchRequest = { version, config }
      const res = await apiFetch<AdminHouseRulesResponse>(
        "/api/admin/rules",
        jsonInit("PATCH", body)
      )
      applyResponse(res)
      toast.success("House rules updated and live.")
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(
          "House rules changed elsewhere. Reloading the latest values."
        )
        await reload()
      } else {
        toast.error(
          err instanceof ApiError
            ? err.message
            : "Could not update house rules."
        )
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>House rules</CardTitle>
        <CardDescription>
          Admin-editable server-wide defaults for the calculation engine.
          Changes take effect immediately on live status; they never rewrite
          historically awarded stats or the permanent consumable ledge.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-xs text-muted-foreground">
            Loading house rules...
          </div>
        ) : config ? (
          <form onSubmit={onSave} className="flex flex-col gap-4">
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                These are <span className="font-medium">house</span> defaults -
                the store&apos;s own rulings. They apply server-wide on every
                read/mutation below, so live status always reflects the current
                values. Lowering an equipment cap never recaps an already-earned
                bonus: the surplus is simply clamped to the new ceiling.
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <HouseRuleInput
                label="Individual equipment cap (%)"
                value={config.equipmentIndividualCapPercent}
                onChange={setPercent("equipmentIndividualCapPercent")}
                min={0}
                max={100}
                hint="Per-item bonus cap as a percentage of the base attribute (default 20)."
              />
              <HouseRuleInput
                label="Combined equipment cap (%)"
                value={config.equipmentCombinedCapPercent}
                onChange={setPercent("equipmentCombinedCapPercent")}
                min={0}
                max={100}
                hint="Total bonus cap from all equipment on an attribute (default 15)."
              />
            </div>

            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                Consumable grade rates
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <HouseRuleInput
                  label="F grade rate"
                  value={config.consumableGradeRates.F}
                  onChange={setGradeRate("F")}
                  min={0}
                  max={100000}
                />
                <HouseRuleInput
                  label="E grade rate"
                  value={config.consumableGradeRates.E}
                  onChange={setGradeRate("E")}
                  min={0}
                  max={100000}
                />
                <HouseRuleInput
                  label="D grade rate"
                  value={config.consumableGradeRates.D}
                  onChange={setGradeRate("D")}
                  min={0}
                  max={100000}
                />
                <HouseRuleInput
                  label="C grade rate"
                  value={config.consumableGradeRates.C}
                  onChange={setGradeRate("C")}
                  min={0}
                  max={100000}
                />
              </div>
              <div className="mt-1.5 text-xs text-muted-foreground">
                Permanent-consumable capacity gained per grade of consumable
                (default F=3, E=5, D=15, C=45).
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <HouseRuleInput
                label="Max transcendent skills per character"
                value={config.maxTranscendentSkills}
                onChange={(value) =>
                  setConfig((prev) =>
                    prev ? { ...prev, maxTranscendentSkills: value } : prev
                  )
                }
                min={0}
                max={8}
                hint="Maximum transcendent skills a character may carry (default 3). Enforced on create, association add and backup import."
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">
                Ruleset version: <span className="font-mono">{version}</span>
              </div>
              <Button type="submit" disabled={saving}>
                <SlidersHorizontalIcon />
                {saving ? "Saving..." : "Save house rules"}
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  )
}

function HouseRuleInput({
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  hint?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint ? (
        <div className="text-xs text-muted-foreground">{hint}</div>
      ) : null}
    </div>
  )
}
