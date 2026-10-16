import type { LucideIcon } from "lucide-react";
import { CalendarClock, CircleUser, Images, ListVideo, MapPin, ScrollText, Tv, Users } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Yayın",
    items: [
      { to: "/devices", label: "Ekranlar", icon: Tv },
      { to: "/media", label: "Medya", icon: Images },
      { to: "/playlists", label: "Oynatma listeleri", icon: ListVideo },
      { to: "/schedules", label: "Zamanlama", icon: CalendarClock },
    ],
  },
  {
    label: "Yönetim",
    items: [
      { to: "/locations", label: "Konumlar", icon: MapPin, adminOnly: true },
      { to: "/users", label: "Kullanıcılar", icon: Users, adminOnly: true },
      { to: "/audit", label: "İşlem kaydı", icon: ScrollText, adminOnly: true },
    ],
  },
  {
    label: "Kişisel",
    items: [{ to: "/account", label: "Hesabım", icon: CircleUser }],
  },
];
