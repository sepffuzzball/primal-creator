"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  LayoutDashboardIcon,
  PlusIcon,
  BookIcon,
  SettingsIcon,
  LogOutIcon,
  SparklesIcon,
} from "lucide-react"

import { apiFetch, type MeResponse, type SessionUser } from "@/lib/api"
import { cn } from "@/lib/utils"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar"

export interface BreadcrumbEntry {
  label: string
  href?: string
}

interface AppShellProps {
  breadcrumbs?: BreadcrumbEntry[]
  children: React.ReactNode
}

interface AppShellContextValue {
  user: SessionUser | null
  refreshUser: () => Promise<void>
  logout: () => Promise<void>
}

const AppShellContext = React.createContext<AppShellContextValue | null>(null)

function useAppShell() {
  const ctx = React.useContext(AppShellContext)
  if (!ctx) {
    throw new Error("useAppShell must be used within an AppShell")
  }
  return ctx
}

const CATALOG_KINDS = [
  { kind: "races", label: "Races" },
  { kind: "classes", label: "Classes" },
  { kind: "professions", label: "Professions" },
  { kind: "titles", label: "Titles" },
  { kind: "equipment", label: "Equipment" },
  { kind: "skills", label: "Skills" },
  { kind: "blessings", label: "Blessings" },
  { kind: "bloodlines", label: "Bloodlines" },
  { kind: "consumables", label: "Consumables" },
  { kind: "evolutions", label: "Evolutions" },
  { kind: "gods", label: "Gods & Patrons" },
] as const

function isCatalogActive(pathname: string, kind: string): boolean {
  return pathname.startsWith(`/catalog/${kind}`)
}

export function AppShell({ breadcrumbs, children }: AppShellProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [user, setUser] = React.useState<SessionUser | null>(null)
  const [loading, setLoading] = React.useState(true)

  const refreshUser = React.useCallback(async () => {
    try {
      const res = await apiFetch<MeResponse>("/api/auth/me")
      setUser(res.user)
    } catch {
      setUser(null)
    }
  }, [])

  React.useEffect(() => {
    let active = true
    apiFetch<MeResponse>("/api/auth/me")
      .then((res) => {
        if (active) setUser(res.user)
      })
      .catch(() => {
        if (active) setUser(null)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const logout = React.useCallback(async () => {
    try {
      await apiFetch<{ ok: boolean }>("/api/auth/logout", { method: "POST" })
    } catch {
      // Even if the server call fails, clear the client session and redirect.
    }
    setUser(null)
    router.push("/login")
    router.refresh()
  }, [router])

  React.useEffect(() => {
    if (!loading && !user) {
      router.replace("/login")
    }
  }, [loading, user, router])

  const navActive = {
    dashboard: pathname === "/",
    newCharacter: pathname === "/characters/new",
    settings: pathname === "/settings",
  }

  const contextValue = React.useMemo<AppShellContextValue>(
    () => ({ user, refreshUser, logout }),
    [user, refreshUser, logout]
  )

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <SparklesIcon className="size-6" />
          <span className="text-xs">Loading...</span>
        </div>
      </div>
    )
  }

  if (!user) {
    return null
  }

  return (
    <AppShellContext.Provider value={contextValue}>
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="lg"
                  isActive={false}
                  render={
                    <Link href="/">
                      <SparklesIcon />
                      <span className="font-heading">Primal Forge</span>
                    </Link>
                  }
                />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Overview</SidebarGroupLabel>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={navActive.dashboard}
                    render={<Link href="/" />}
                    tooltip="Dashboard"
                  >
                    <LayoutDashboardIcon />
                    <span>Dashboard</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={navActive.newCharacter}
                    render={<Link href="/characters/new" />}
                    tooltip="New Character"
                  >
                    <PlusIcon />
                    <span>New Character</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>

            <SidebarGroup>
              <SidebarGroupLabel>Catalog</SidebarGroupLabel>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={CATALOG_KINDS.some((c) =>
                      isCatalogActive(pathname, c.kind)
                    )}
                    tooltip="Catalog"
                  >
                    <BookIcon />
                    <span>Catalog</span>
                  </SidebarMenuButton>
                  <SidebarMenuSub>
                    {CATALOG_KINDS.map((c) => {
                      const active = isCatalogActive(pathname, c.kind)
                      return (
                        <SidebarMenuSubItem key={c.kind}>
                          <SidebarMenuSubButton
                            isActive={active}
                            render={<Link href={`/catalog/${c.kind}`} />}
                          >
                            <span>{c.label}</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      )
                    })}
                  </SidebarMenuSub>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>

            <SidebarGroup>
              <SidebarGroupLabel>Account</SidebarGroupLabel>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={navActive.settings}
                    render={<Link href="/settings" />}
                    tooltip="Settings"
                  >
                    <SettingsIcon />
                    <span>Settings</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter>
            <div className="px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
              <div className="truncate">{user.email}</div>
              {user.isAdmin ? (
                <div className="font-medium text-foreground">Admin</div>
              ) : null}
            </div>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={logout} tooltip="Log out">
                  <LogOutIcon />
                  <span>Log out</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>

        <SidebarInset>
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger />
            {breadcrumbs && breadcrumbs.length > 0 ? (
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink render={<Link href="/" />}>
                      Home
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  {breadcrumbs.map((crumb, i) => {
                    const isLast = i === breadcrumbs.length - 1
                    return (
                      <React.Fragment key={`${crumb.label}-${i}`}>
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                          {crumb.href && !isLast ? (
                            <BreadcrumbLink render={<Link href={crumb.href} />}>
                              {crumb.label}
                            </BreadcrumbLink>
                          ) : (
                            <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                          )}
                        </BreadcrumbItem>
                      </React.Fragment>
                    )
                  })}
                </BreadcrumbList>
              </Breadcrumb>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              <ThemeToggle />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Log out"
                title="Log out"
                onClick={logout}
              >
                <LogOutIcon />
              </Button>
            </div>
          </header>
          <div className="flex-1 overflow-auto p-4 md:p-6">
            <div className={cn("mx-auto w-full max-w-6xl min-w-0")}>
              {children}
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </AppShellContext.Provider>
  )
}

export { useAppShell }
