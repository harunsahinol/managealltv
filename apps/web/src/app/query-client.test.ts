import { describe, expect, it } from "vitest";
import { keys } from "../lib/api/keys";
import { clearAccountQueries, createQueryClient } from "./query-client";

describe("clearAccountQueries", () => {
  it("drops the previous account's cached data but keeps the session query", () => {
    const client = createQueryClient();
    client.setQueryData(keys.me, null);
    client.setQueryData(keys.devices, [{ id: "d_admin_only" }]);
    client.setQueryData(keys.device("d_admin_only"), { id: "d_admin_only" });
    client.setQueryData(keys.locations, [{ id: "loc_1" }]);
    client.setQueryData(keys.audit, { pages: [], pageParams: [] });

    clearAccountQueries(client);

    expect(client.getQueryCache().findAll().map((query) => query.queryKey)).toEqual([keys.me]);
    expect(client.getQueryData(keys.devices)).toBeUndefined();
    expect(client.getQueryData(keys.device("d_admin_only"))).toBeUndefined();
  });
});
