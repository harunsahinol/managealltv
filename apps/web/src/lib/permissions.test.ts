import { describe, expect, it } from "vitest";
import { canControlDevice, canDeleteMedia, canEditContent, canEditSchedule, canManageSchedules, isAdmin } from "./permissions";

const admin = { role: "admin" as const, locationIds: [], name: "Ayşe Yönetici" };
const editor = { role: "editor" as const, locationIds: ["loc-a"], name: "Ece Editör" };
const viewer = { role: "viewer" as const, locationIds: ["loc-a"], name: "Veli İzleyici" };

describe("role checks follow docs/API.md", () => {
  it("admins can do everything", () => {
    expect(isAdmin(admin)).toBe(true);
    expect(canControlDevice(admin, { locationId: "anywhere" })).toBe(true);
    expect(canEditContent(admin)).toBe(true);
    expect(canDeleteMedia(admin, { uploadedByName: "Başkası" })).toBe(true);
  });

  it("editors control devices only in their locations", () => {
    expect(canControlDevice(editor, { locationId: "loc-a" })).toBe(true);
    expect(canControlDevice(editor, { locationId: "loc-b" })).toBe(false);
  });

  it("editors delete only their own uploads", () => {
    expect(canDeleteMedia(editor, { uploadedByName: "Ece Editör" })).toBe(true);
    expect(canDeleteMedia(editor, { uploadedByName: "Başkası" })).toBe(false);
    expect(canDeleteMedia(editor, { uploadedByName: null })).toBe(false);
  });

  it("viewers are read-only", () => {
    expect(canControlDevice(viewer, { locationId: "loc-a" })).toBe(false);
    expect(canEditContent(viewer)).toBe(false);
    expect(canManageSchedules(viewer)).toBe(false);
    expect(canDeleteMedia(viewer, { uploadedByName: "Veli İzleyici" })).toBe(false);
  });

  it("editors edit schedules whose target is in scope", () => {
    const deviceLocation = (id: string) => ({ "dev-1": "loc-a", "dev-2": "loc-b" })[id];
    expect(canEditSchedule(editor, { targetType: "location", targetId: "loc-a" }, deviceLocation)).toBe(true);
    expect(canEditSchedule(editor, { targetType: "location", targetId: "loc-b" }, deviceLocation)).toBe(false);
    expect(canEditSchedule(editor, { targetType: "device", targetId: "dev-1" }, deviceLocation)).toBe(true);
    expect(canEditSchedule(editor, { targetType: "device", targetId: "dev-2" }, deviceLocation)).toBe(false);
    expect(canEditSchedule(editor, { targetType: "device", targetId: "unknown" }, deviceLocation)).toBe(false);
    expect(canEditSchedule(viewer, { targetType: "location", targetId: "loc-a" }, deviceLocation)).toBe(false);
    expect(canEditSchedule(admin, { targetType: "device", targetId: "unknown" }, deviceLocation)).toBe(true);
  });
});
