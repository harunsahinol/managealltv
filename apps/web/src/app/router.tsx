import { type ComponentType, lazy } from "react";
import { createBrowserRouter, Navigate } from "react-router";
import { DevicesPage } from "../pages/devices/devices-page";
import { InvitePage } from "../pages/invite-page";
import { LoginPage } from "../pages/login-page";
import { NotFoundPage } from "../pages/not-found-page";
import { AppShell } from "./app-shell";
import { RequireAdmin, RequireAuth } from "./session";

/** Route-level code splitting: the landing page (Ekranlar) ships in the main bundle, the rest on demand. */
function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(async () => ({ default: (await load())[name] }));
}

const DeviceDetailPage = page(() => import("../pages/devices/device-detail-page"), "DeviceDetailPage");
const MediaPage = page(() => import("../pages/media/media-page"), "MediaPage");
const PlaylistsPage = page(() => import("../pages/playlists/playlists-page"), "PlaylistsPage");
const PlaylistEditorPage = page(() => import("../pages/playlists/playlist-editor-page"), "PlaylistEditorPage");
const SchedulesPage = page(() => import("../pages/schedules/schedules-page"), "SchedulesPage");
const LocationsPage = page(() => import("../pages/locations-page"), "LocationsPage");
const UsersPage = page(() => import("../pages/users-page"), "UsersPage");
const AuditPage = page(() => import("../pages/audit-page"), "AuditPage");
const AccountPage = page(() => import("../pages/account-page"), "AccountPage");

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/invite/:token", element: <InvitePage /> },
  {
    path: "/",
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/devices" replace /> },
      { path: "devices", element: <DevicesPage /> },
      { path: "devices/:id", element: <DeviceDetailPage /> },
      { path: "media", element: <MediaPage /> },
      { path: "playlists", element: <PlaylistsPage /> },
      { path: "playlists/:id", element: <PlaylistEditorPage /> },
      { path: "schedules", element: <SchedulesPage /> },
      {
        path: "locations",
        element: (
          <RequireAdmin>
            <LocationsPage />
          </RequireAdmin>
        ),
      },
      {
        path: "users",
        element: (
          <RequireAdmin>
            <UsersPage />
          </RequireAdmin>
        ),
      },
      {
        path: "audit",
        element: (
          <RequireAdmin>
            <AuditPage />
          </RequireAdmin>
        ),
      },
      { path: "account", element: <AccountPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
