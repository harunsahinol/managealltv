import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DeviceStatus,
  DeviceToServer,
  Manifest,
  manifestIssues,
  PairPollResponse,
  PairRequest,
  PairResponse,
  resolveActivePlaylist,
  ScheduleRule,
  ServerToDevice,
  toLocalMoment,
} from "../src/index";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

describe("fixtures match the schemas", () => {
  it("manifest", () => {
    const manifest = Manifest.parse(fixture("manifest.json"));
    expect(manifestIssues(manifest)).toEqual([]);
  });

  it("pairing", () => {
    PairRequest.parse(fixture("pair-request.json"));
    PairResponse.parse(fixture("pair-response.json"));
    z.array(PairPollResponse).parse(fixture("pair-poll-responses.json"));
  });

  it("device status", () => {
    DeviceStatus.parse(fixture("device-status.json"));
  });

  it("websocket messages", () => {
    const toDevice = z.array(ServerToDevice).parse(fixture("ws-server-to-device.json"));
    const toServer = z.array(DeviceToServer).parse(fixture("ws-device-to-server.json"));
    // Every command type is covered so the Kotlin side is tested against all of them.
    const commandTypes = new Set(toDevice.flatMap((m) => (m.type === "command" ? [m.command.type] : [])));
    expect([...commandTypes].sort()).toEqual(["identify", "reboot", "reload", "restart_app", "set_volume"]);
    expect(new Set(toDevice.map((m) => m.type))).toEqual(new Set(["manifest_updated", "command", "unpaired"]));
    expect(new Set(toServer.map((m) => m.type))).toEqual(new Set(["status", "command_result"]));
  });
});

describe("manifestIssues", () => {
  const base = Manifest.parse(fixture("manifest.json"));

  it("reports dangling references", () => {
    const broken: Manifest = {
      ...base,
      defaultPlaylistId: "pl_missing",
      playlists: [...base.playlists, { id: "pl_x", name: "x", items: [{ mediaId: "med_missing", durationSec: null }] }],
      schedule: [{ ...base.schedule[0]!, playlistId: "pl_missing" }],
    };
    expect(manifestIssues(broken)).toEqual([
      "playlist pl_x references unknown media med_missing",
      "unknown default playlist pl_missing",
      "rule sch_lunch references unknown playlist pl_missing",
    ]);
  });

  it("reports unused and duplicate media", () => {
    const extra = { ...base.media[0]!, id: "med_unused" };
    expect(manifestIssues({ ...base, media: [...base.media, extra, extra] })).toEqual([
      "duplicate media med_unused",
      "media med_unused is not used by any playlist",
    ]);
  });
});

const ScheduleCases = z.object({
  groups: z.array(
    z.object({
      name: z.string(),
      timezone: z.string(),
      defaultPlaylistId: z.string().nullable(),
      rules: z.array(ScheduleRule),
      cases: z.array(
        z.object({
          name: z.string(),
          nowUtc: z.string(),
          expectedPlaylistId: z.string().nullable(),
        }),
      ),
    }),
  ),
});

describe("schedule test vectors", () => {
  const { groups } = ScheduleCases.parse(fixture("schedule-cases.json"));
  for (const group of groups) {
    describe(group.name, () => {
      for (const c of group.cases) {
        it(c.name, () => {
          const now = toLocalMoment(new Date(c.nowUtc), group.timezone);
          expect(resolveActivePlaylist(group.rules, group.defaultPlaylistId, now).playlistId).toBe(
            c.expectedPlaylistId,
          );
        });
      }
    });
  }
});

describe("toLocalMoment", () => {
  it("converts to Istanbul wall clock time", () => {
    expect(toLocalMoment(new Date("2026-10-14T21:30:00Z"), "Europe/Istanbul")).toEqual({
      date: "2026-10-15",
      weekday: "thu",
      minutes: 30,
    });
  });
});
