import { describe, expect, test } from "bun:test";
import {
  CREW_FEATURE_NAME,
  buildOperatorProfileFromActor,
  formatCrewBadgeHtml,
  getActorCrewData,
  getPrimaryUserId,
  normalizeRatings,
} from "../scripts/foundry/crew.js";
import { buildShipConsoleView } from "../scripts/foundry/ship-view-model.js";
import { CANADENSIS_CONFIG } from "../scripts/data/canadensis.js";
import { createInitialState } from "../scripts/model/defaults.js";

describe("crew qualification feature and profile extraction", () => {
  test("normalizeRatings clamps values to integers between 1 and 10", () => {
    expect(normalizeRatings({ piloting: 0, gunnery: 12, sensors: 4.6, engineering: -5 })).toEqual({
      piloting: 1,
      gunnery: 10,
      sensors: 5,
      engineering: 1,
    });
    expect(normalizeRatings({})).toEqual({
      piloting: 1,
      gunnery: 1,
      sensors: 1,
      engineering: 1,
    });
  });

  test("formatCrewBadgeHtml generates badge with ratings and type", () => {
    const html = formatCrewBadgeHtml({ piloting: 6, gunnery: 4, sensors: 3, engineering: 8 }, "pc");
    expect(html).toContain("Pilot:</strong> 6");
    expect(html).toContain("Gunnery:</strong> 4");
    expect(html).toContain("Sensors:</strong> 3");
    expect(html).toContain("Engineering:</strong> 8");
    expect(html).toContain("PC");
  });

  test("getActorCrewData extracts ratings from embedded crew feature item", () => {
    const actor = {
      id: "actor-1",
      name: "Commander Shepard",
      type: "character",
      items: [
        {
          id: "item-feat-1",
          name: CREW_FEATURE_NAME,
          type: "feat",
          flags: {
            "vira-shipcombat": {
              isCrewRole: true,
              crewRole: {
                ratings: { piloting: 7, gunnery: 8, sensors: 5, engineering: 4 },
                type: "pc",
                capabilities: { work: true, repairDrone: false },
              },
            },
          },
        },
      ],
    };

    const crewData = getActorCrewData(actor);
    expect(crewData.ratings).toEqual({ piloting: 7, gunnery: 8, sensors: 5, engineering: 4 });
    expect(crewData.type).toBe("pc");
    expect(crewData.capabilities.work).toBe(true);
    expect(crewData.item).not.toBeNull();
  });

  test("getActorCrewData falls back to defaults when no feature or flags exist", () => {
    const npcActor = {
      id: "npc-1",
      name: "Security Officer",
      type: "npc",
      items: [],
    };

    const crewData = getActorCrewData(npcActor);
    expect(crewData.ratings).toEqual({ piloting: 1, gunnery: 1, sensors: 1, engineering: 1 });
    expect(crewData.type).toBe("npc");
    expect(crewData.capabilities.work).toBe(true);
    expect(crewData.item).toBeNull();
  });

  test("getPrimaryUserId finds the non-GM user with OWNER permission", () => {
    globalThis.game = {
      users: new Map([
        ["gm-1", { id: "gm-1", isGM: true }],
        ["player-1", { id: "player-1", isGM: false }],
      ]),
    };
    globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };

    const actor = {
      ownership: {
        default: 0,
        "gm-1": 3,
        "player-1": 3,
      },
    };

    expect(getPrimaryUserId(actor)).toBe("player-1");
  });

  test("buildOperatorProfileFromActor builds full ship operator profile", () => {
    const actor = {
      id: "actor-99",
      name: "Liara T'Soni",
      type: "character",
      img: "icons/liara.png",
      ownership: { default: 0, "player-1": 3 },
      items: [
        {
          id: "item-feat-99",
          name: CREW_FEATURE_NAME,
          type: "feat",
          flags: {
            "vira-shipcombat": {
              isCrewRole: true,
              crewRole: {
                ratings: { piloting: 3, gunnery: 5, sensors: 9, engineering: 7 },
                type: "pc",
                capabilities: { work: true },
              },
            },
          },
        },
      ],
    };

    const profile = buildOperatorProfileFromActor(actor);
    expect(profile.id).toBe("actor-actor-99");
    expect(profile.label).toBe("Liara T'Soni");
    expect(profile.actorId).toBe("actor-99");
    expect(profile.userId).toBe("player-1");
    expect(profile.ratings).toEqual({ piloting: 3, gunnery: 5, sensors: 9, engineering: 7 });
    expect(profile.img).toBe("icons/liara.png");
  });
});

describe("ship console stationSlots view model", () => {
  test("stationSlots renders all supported Command and Crew slots matching capacity", () => {
    const config = structuredClone(CANADENSIS_CONFIG);
    const state = createInitialState(config);

    const view = buildShipConsoleView(config, state);

    expect(view.stationSlots).toBeDefined();
    expect(view.stationSlots.command.length).toBe(config.commandCapacity);
    expect(view.stationSlots.crew.length).toBe(config.crewCapacity);

    // Initial Canadensis state assigns 2 command and 2 crew
    expect(view.stationSlots.command[0].occupied).toBe(true);
    expect(view.stationSlots.command[0].operator.label).toBe("Pilot / Commander");
    expect(view.stationSlots.command[1].occupied).toBe(true);
    expect(view.stationSlots.command[1].operator.label).toBe("Gunner / Sensor Operator");

    expect(view.stationSlots.crew[0].occupied).toBe(true);
    expect(view.stationSlots.crew[1].occupied).toBe(true);
  });

  test("stationSlots correctly identifies empty slots when unassigned", () => {
    const config = structuredClone(CANADENSIS_CONFIG);
    const state = createInitialState(config);
    state.roster.command = []; // Clear command slots

    const view = buildShipConsoleView(config, state);

    expect(view.stationSlots.command[0].occupied).toBe(false);
    expect(view.stationSlots.command[0].empty).toBe(true);
    expect(view.stationSlots.command[0].operator).toBeNull();
    expect(view.stationSlots.command[0].label).toBe("Command 1");

    expect(view.stationSlots.command[1].occupied).toBe(false);
    expect(view.stationSlots.command[1].empty).toBe(true);
    expect(view.stationSlots.command[1].operator).toBeNull();
  });
});

describe("crew qualification feature persistence and sync", () => {
  test("ensureActorCrewFeature creates or updates embedded item document", async () => {
    let createdPayload = null;
    const mockActor = {
      id: "actor-42",
      name: "Tali'Zorah",
      type: "character",
      items: [],
      async createEmbeddedDocuments(docType, docs) {
        createdPayload = docs[0];
        const item = { ...docs[0], id: "new-item-42" };
        this.items.push(item);
        return [item];
      },
    };

    const { ensureActorCrewFeature } = await import("../scripts/foundry/crew.js");
    const item = await ensureActorCrewFeature(mockActor, {
      ratings: { engineering: 9, sensors: 7 },
      type: "pc",
    });

    expect(item).toBeDefined();
    expect(createdPayload.name).toBe(CREW_FEATURE_NAME);
    expect(createdPayload.flags["vira-shipcombat"].crewRole.ratings.engineering).toBe(9);
    expect(createdPayload.flags["vira-shipcombat"].crewRole.ratings.sensors).toBe(7);
    expect(createdPayload.system.description.value).toContain("Engineering:</strong> 9");
  });

  test("syncAssignedShips updates operator profiles on matching ships", async () => {
    const { syncAssignedShips } = await import("../scripts/foundry/crew-sheet.js");
    let updatedPayload = null;
    const mockShip = {
      type: "vira-shipcombat.ship",
      system: {
        shipCombat: {
          config: {
            operators: [
              {
                id: "actor-actor-42",
                actorId: "actor-42",
                label: "Tali'Zorah",
                ratings: { piloting: 1, gunnery: 1, sensors: 1, engineering: 5 },
              },
            ],
          },
        },
      },
      async update(diff) {
        updatedPayload = diff;
      },
    };

    globalThis.game = {
      actors: [mockShip],
      user: { id: "gm", isGM: true },
    };

    await syncAssignedShips("actor-42", {
      ratings: { piloting: 3, gunnery: 2, sensors: 8, engineering: 10 },
      label: "Tali'Zorah vas Normandy",
    });

    expect(updatedPayload).toBeDefined();
    const updatedOps = updatedPayload["system.shipCombat.config.operators"];
    expect(updatedOps[0].label).toBe("Tali'Zorah vas Normandy");
    expect(updatedOps[0].ratings.engineering).toBe(10);
    expect(updatedOps[0].ratings.sensors).toBe(8);
  });

  test("syncAssignedShips writes nothing for a non-GM client", async () => {
    const { syncAssignedShips } = await import("../scripts/foundry/crew-sheet.js");
    let updatedPayload = null;
    const mockShip = {
      type: "vira-shipcombat.ship",
      system: {
        shipCombat: {
          config: {
            operators: [
              { id: "actor-actor-42", actorId: "actor-42", label: "Tali'Zorah" },
            ],
          },
        },
      },
      async update(diff) {
        updatedPayload = diff;
      },
    };

    globalThis.game = {
      actors: [mockShip],
      user: { id: "player", isGM: false },
    };

    await syncAssignedShips("actor-42", { label: "Tali'Zorah vas Normandy" });

    expect(updatedPayload).toBeNull();
  });
});

