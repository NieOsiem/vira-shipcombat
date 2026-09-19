// Live-world migration: install the Inertial Anchor ("Vector Authority" drive) on every ship.
//
// Run it from the GM client of a world: paste the whole file into the browser console (or evaluate it
// over CDP), then call:
//     await __viraMigrate(false)   // dry run — prints every change it would make
//     await __viraMigrate(true)    // apply
//
// It is idempotent: re-running it reports "no changes needed" for anything already migrated.
// What it does, per ship Actor:
//   1. bumps the reference reactor to 14/16 so the anchor's 2-point draw fits;
//   2. adds the `canadensis-slot-inertia` slot (with the sibling fields `assertSlot` validates);
//   3. adds `regenerationWeightCap`, `evasionHardReserve`, `evasionHardAcCap` to the hull config;
//   4. repoints `capabilityProfile.evasionHardware` at the anchor drive;
//   5. adds the `inertiaFailure` fault to all four critical pools;
//   6. sets `state.power.inertia = 2` and inserts `inertia` into `sheddingPriority`;
//   7. installs the referenced-but-missing Mk II component Item with the module's internal-mutation
//      flags (the same write path the module's own initialization uses).
// It also publishes the three reference drives as world Items and into the `ship-components` pack.
globalThis.__viraMigrate = async function (apply) {
  const HULL_ID = "canadensis-training-corvette";
  const SLOT_ID = "canadensis-slot-inertia";
  const ITEM_ID = "CanadInertia0001";
  const REACTOR_ID = "CanadReactor0001";
  const SHIP_TYPE = "vira-shipcombat.ship";
  const COMPONENT_TYPE = "vira-shipcombat.component";
  const SECTORS = ["fore", "port", "starboard", "aft"];
  const INTERNAL = { viraShipCombatInternalUpdate: true, viraShipCombatInitialization: true };

  const DRIVES = [
    {
      _id: "CanadInertiaLt01",
      name: "Inertial Anchor Mk I",
      tiers: [{ power: 0, online: false, pivot: 0 }, { power: 1, online: true, pivot: 45 }],
    },
    {
      _id: ITEM_ID,
      name: "Inertial Anchor Mk II",
      tiers: [
        { power: 0, online: false, pivot: 0 },
        { power: 1, online: true, pivot: 30 },
        { power: 2, online: true, pivot: 60 },
      ],
    },
    {
      _id: "CanadInertiaHv01",
      name: "Inertial Anchor Mk III",
      tiers: [
        { power: 0, online: false, pivot: 0 },
        { power: 1, online: true, pivot: 10 },
        { power: 2, online: true, pivot: 40 },
        { power: 3, online: true, pivot: 75 },
      ],
    },
  ];
  const itemData = (drive) => ({
    _id: drive._id,
    name: drive.name,
    type: COMPONENT_TYPE,
    img: "icons/svg/clockwork.svg",
    system: {
      schemaVersion: 2,
      componentClass: "inertia",
      size: "medium",
      driveRole: "",
      definition: { tiers: drive.tiers, recoveryWork: 3 },
    },
  });
  const change = (bucket, field, from, to) => bucket.push({ field, from, to });
  const inSector = (actor) => actor.type === SHIP_TYPE;

  const report = { mode: apply ? "APPLY" : "DRY RUN", blueprints: [], ships: [], pack: [] };

  // ---- 1. world blueprint Items
  for (const drive of DRIVES) {
    const existing = game.items.get(drive._id);
    report.blueprints.push({ id: drive._id, name: drive.name, action: existing ? "exists" : "create" });
    if (!existing && apply) {
      const created = await Item.create(itemData(drive), { keepId: true });
      if (!created) throw new Error(`Failed to create world Item ${drive._id}`);
    }
  }

  // ---- 2. compendium blueprints (the refit picker reads this pack)
  const pack = game.packs.get("vira-shipcombat.ship-components");
  if (pack) {
    const known = new Set([...pack.index].map((entry) => entry.name));
    const missing = DRIVES.filter((drive) => !known.has(drive.name));
    report.pack.push({ pack: pack.collection, locked: pack.locked, missing: missing.map((d) => d.name) });
    if (missing.length && apply) {
      const wasLocked = pack.locked;
      try {
        if (wasLocked) await pack.configure({ locked: false });
        for (const drive of missing) {
          await pack.importDocument(game.items.get(drive._id) ?? itemData(drive));
        }
        report.pack.push({ imported: missing.map((d) => d.name) });
      } catch (error) {
        report.pack.push({ error: `compendium import failed: ${error.message}` });
      } finally {
        if (wasLocked) {
          try { await pack.configure({ locked: true }); } catch (error) { report.pack.push({ error: `re-lock failed: ${error.message}` }); }
        }
      }
    }
  }

  // ---- 3. patch every ship's stored config and state
  for (const actor of game.actors.filter(inSector)) {
    const entry = { id: actor.id, name: actor.name, changes: [], notes: [] };
    const ship = actor.system?.shipCombat;
    if (!ship?.config) { entry.notes.push("no ship config; skipped"); report.ships.push(entry); continue; }
    if (ship.config.id !== HULL_ID) entry.notes.push(`hull ${ship.config.id} — field defaults assume the reference hull`);

    const config = ship.config;
    const state = ship.state;
    const updates = {};

    // reactor first: the anchor's draw must fit the new nominal output
    const reactor = actor.items.get(REACTOR_ID);
    if (reactor) {
      const def = reactor.system.definition ?? {};
      if (def.nominalOutput !== 14 || def.redlineOutput !== 16) {
        change(entry.changes, `reactor ${REACTOR_ID}`, `${def.nominalOutput}/${def.redlineOutput}`, "14/16");
        if (apply) await reactor.update({ "system.definition.nominalOutput": 14, "system.definition.redlineOutput": 16 }, INTERNAL);
      }
    } else entry.notes.push("reference reactor missing");

    const wantedSlot = {
      id: SLOT_ID,
      label: "Inertial Anchor",
      class: "inertia",
      size: "medium",
      regions: SECTORS,
      itemId: ITEM_ID,
    };
    const slots = Array.isArray(config.slots) ? config.slots : [];
    const slotIndex = slots.findIndex((slot) => slot.id === SLOT_ID);
    if (slotIndex === -1) {
      change(entry.changes, "config.slots", `${slots.length} slots`, `+ ${SLOT_ID} -> ${ITEM_ID}`);
      updates["system.shipCombat.config.slots"] = [...slots, wantedSlot];
    } else if (!slots[slotIndex].size || !Array.isArray(slots[slotIndex].regions)) {
      change(entry.changes, "config.slots", `incomplete ${SLOT_ID}`, "size + regions");
      updates["system.shipCombat.config.slots"] = slots.map((slot, index) =>
        index === slotIndex ? { ...slot, size: wantedSlot.size, regions: wantedSlot.regions } : slot);
    }

    for (const [field, value] of [["regenerationWeightCap", 50], ["evasionHardReserve", 30], ["evasionHardAcCap", 4]]) {
      if (config[field] !== value) {
        change(entry.changes, `config.${field}`, config[field] ?? "(absent)", value);
        updates[`system.shipCombat.config.${field}`] = value;
      }
    }

    const hardware = config.capabilityProfile?.evasionHardware ?? [];
    const wanted = [{ slotId: SLOT_ID, channel: "inertiaFailure" }];
    if (JSON.stringify(hardware) !== JSON.stringify(wanted)) {
      change(entry.changes, "capabilityProfile.evasionHardware", hardware.map((h) => h.slotId).join(", "), SLOT_ID);
      updates["system.shipCombat.config.capabilityProfile"] = { ...config.capabilityProfile, evasionHardware: wanted };
    }

    const pools = config.criticalPools ?? {};
    const faultEntry = { id: `inertiaFailure:${SLOT_ID}`, kind: "fault", channelId: "inertiaFailure", sector: null, weight: 1, slotId: SLOT_ID };
    const patched = {};
    for (const [sector, entries] of Object.entries(pools)) {
      const list = Array.isArray(entries) ? entries : [];
      if (list.some((item) => item.slotId === SLOT_ID && item.channelId === "inertiaFailure")) continue;
      patched[sector] = [...list, faultEntry];
      change(entry.changes, `config.criticalPools.${sector}`, `${list.length} entries`, "+ inertiaFailure");
    }
    if (Object.keys(patched).length) updates["system.shipCombat.config.criticalPools"] = { ...pools, ...patched };

    const power = { ...(state.power ?? {}) };
    if (Number(power.inertia ?? 0) !== 2) {
      change(entry.changes, "state.power.inertia", power.inertia ?? "(absent)", 2);
      power.inertia = 2;
      updates["system.shipCombat.state.power"] = power;
    }
    const priority = Array.isArray(state.sheddingPriority) ? state.sheddingPriority : [];
    if (!priority.includes("inertia")) {
      const next = ["sensors", "engines", "inertia", "shields", "cooling", "weapons"];
      change(entry.changes, "state.sheddingPriority", priority.join(" -> "), next.join(" -> "));
      updates["system.shipCombat.state.sheddingPriority"] = next;
    }

    if (Object.keys(updates).length && apply) {
      const updated = await actor.update(updates);
      if (!updated) throw new Error(`Failed to update ${actor.name}`);
    } else if (!Object.keys(updates).length) entry.notes.push("no changes needed");
    report.ships.push(entry);
  }

  // ---- 4. install referenced-but-missing components, mirroring initializeShipActor's
  // installReferencedDefaults (which lives inside the bundle and cannot be called from outside)
  for (const actor of game.actors.filter(inSector)) {
    const cfg = actor.system?.shipCombat?.config;
    if (!cfg) continue;
    const references = new Set([
      ...(cfg.slots ?? []).map((slot) => slot.itemId),
      ...(cfg.hardpoints ?? []).map((hardpoint) => hardpoint.weaponId),
    ].filter(Boolean));
    const missing = DRIVES.filter((drive) => references.has(drive._id) && !actor.items.get(drive._id));
    const entry = report.ships.find((ship) => ship.id === actor.id);
    if (!missing.length) continue;
    for (const drive of missing) {
      entry?.changes.push({ field: "items", from: "(missing)", to: `${drive._id} ${drive.name}` });
      if (apply && !actor.items.get(drive._id)) {
        const created = await actor.createEmbeddedDocuments("Item", [itemData(drive)], { keepId: true, ...INTERNAL });
        if (!created?.length) throw new Error(`Failed to install ${drive._id} on ${actor.name}`);
      }
    }
  }

  if (apply) await new Promise((resolve) => setTimeout(resolve, 1200));

  // ---- 5. verify
  for (const entry of report.ships) {
    const actor = game.actors.get(entry.id);
    if (!actor) continue;
    const cfg = actor.system.shipCombat.config;
    entry.verified = {
      slot: (cfg.slots ?? []).some((slot) => slot.id === SLOT_ID && slot.size),
      componentInstalled: Boolean(actor.items.get(ITEM_ID)),
      powerInertia: actor.system.shipCombat.state.power?.inertia ?? null,
      sheddingPriority: (actor.system.shipCombat.state.sheddingPriority ?? []).join(","),
      regenerationWeightCap: cfg.regenerationWeightCap ?? null,
      evasionHardReserve: cfg.evasionHardReserve ?? null,
      evasionHardware: (cfg.capabilityProfile?.evasionHardware ?? []).map((h) => h.slotId).join(","),
      inertiaFaultPools: Object.entries(cfg.criticalPools ?? {})
        .filter(([, list]) => (list ?? []).some((item) => item.channelId === "inertiaFailure"))
        .map(([sector]) => sector).join(","),
    };
  }
  return report;
};

// Optional follow-up, kept separate because it changes printed weapon damage on live content:
//     await __viraSyncReferenceWeapons(false)   // dry run — lists every number that would change
//     await __viraSyncReferenceWeapons(true)    // apply
// Syncs the installed reference weapons to the shipped balance numbers (railgun shield 4->6 and
// overclock hull 15->16, laser 10/5 -> 12/6 and overclock shield 13->15, macrocannon 6/8 -> 7/9).
globalThis.__viraSyncReferenceWeapons = async function (apply) {
  const SHIP_TYPE = "vira-shipcombat.ship";
  const INTERNAL = { viraShipCombatInternalUpdate: true, viraShipCombatInitialization: true };
  const PATCHES = {
    CanadRailgun0001: { damage: { shield: 6, hull: 12 }, overclock: { hull: 16 } },
    CanadLaser000001: { damage: { shield: 12, hull: 6 }, overclock: { shield: 15 } },
    CanadMacrocanA01: { damage: { shield: 7, hull: 9 }, overclock: null },
    CanadMacrocanB01: { damage: { shield: 7, hull: 9 }, overclock: null },
  };
  const report = { mode: apply ? "APPLY" : "DRY RUN", changes: [] };
  for (const actor of game.actors.filter((a) => a.type === SHIP_TYPE)) {
    for (const item of actor.items) {
      const patch = PATCHES[item.id];
      if (!patch) continue;
      const updates = {};
      for (const [field, value] of Object.entries(patch.damage)) {
        const current = item.system.definition?.damage?.[field];
        if (current !== value) {
          report.changes.push({ ship: actor.name, weapon: item.name, field: `damage.${field}`, from: current, to: value });
          updates[`system.definition.damage.${field}`] = value;
        }
      }
      for (const [field, value] of Object.entries(patch.overclock ?? {})) {
        const current = item.system.definition?.modes?.overclock?.overrides?.damage?.[field];
        if (current !== value) {
          report.changes.push({ ship: actor.name, weapon: item.name, field: `overclock.damage.${field}`, from: current, to: value });
          updates[`system.definition.modes.overclock.overrides.damage.${field}`] = value;
        }
      }
      if (Object.keys(updates).length && apply) {
        const updated = await item.update(updates, INTERNAL);
        if (!updated) throw new Error(`Failed to update ${item.name} on ${actor.name}`);
      }
    }
  }
  return report;
};
