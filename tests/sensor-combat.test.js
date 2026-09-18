import { describe, expect, test } from "bun:test";

import { CANADENSIS_IDS } from "../scripts/data/canadensis.js";
import { createDefaultShipData, createInitialState } from "../scripts/model/defaults.js";
import {
  TRACK_STATUS,
  acquireTarget,
  analyzeDefenses,
  breakLock,
  burnThrough,
  calculateFiringSolution,
  consumeFiringSolution,
  deepScan,
  getCurrentSignature,
  jamTarget,
  passiveDetection,
  refreshObserverTracks,
  sanitizeTrack,
} from "../scripts/rules/sensors.js";
import {
  BARRAGE_PROFILES,
  advanceWeaponRecovery,
  beginWeaponReload,
  calculateEffectiveHits,
  commitAttack,
  contributeWeaponReload,
  previewAttack,
} from "../scripts/rules/combat.js";
import { resolveAttack, resolveProjectile } from "../scripts/rules/damage.js";
import {
  applyConditionTiers,
  processHazardEnd,
  selectCondition,
} from "../scripts/rules/conditions.js";
import { executeShipOperation } from "../scripts/rules/operations.js";

const GUNNER = "canadensis-gunner-sensor";

function clone(value) {
  return structuredClone(value);
}

function freshShip() {
  const defaults = createDefaultShipData();
  const config = clone(defaults.config);
  return { config, state: createInitialState(config) };
}

function expectViolation(callback, code) {
  let thrown;
  try {
    callback();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  expect(thrown?.code).toBe(code);
  return thrown;
}

function prepareAttack({
  weaponId = CANADENSIS_IDS.railgun,
  attackerPosition = { x: 0, y: 0 },
  targetPosition = { x: 0, y: -30 },
  targetFacing = 0,
  firingSolution = false,
} = {}) {
  const attacker = freshShip();
  const target = freshShip();
  attacker.state.phase = "active";
  attacker.state.resources.actions[GUNNER] = 1;
  attacker.state.weapons[weaponId].status = "online";
  attacker.state.tracks.target = {
    targetUuid: "target",
    state: TRACK_STATUS.TARGETED,
    passiveContact: true,
    defensesRevealed: false,
    systemsRevealed: false,
    firingSolution,
    remembered: {},
    jams: [],
  };
  const declaration = {
    targetUuid: "target",
    weaponId,
    operatorId: GUNNER,
    attackerPosition,
    targetPosition,
    attackerVelocity: { x: 0, y: 0 },
    targetVelocity: { x: 0, y: 0 },
    attackerFacing: 0,
    targetFacing,
    lineOfSight: true,
  };
  return { attacker, target, declaration };
}

describe("sensor signatures and tracks", () => {
  test("emission and thermal thresholds use the inclusive boundary classes", () => {
    const { config, state } = freshShip();
    config.components.reactor.nominalOutput = 100;
    config.heatCapacity = 100;

    const emissionAt = (committed) => {
      const input = clone(state);
      input.power = { committed };
      return getCurrentSignature(config, input).emission;
    };
    expect([
      emissionAt(0),
      emissionAt(25),
      emissionAt(25.01),
      emissionAt(45),
      emissionAt(45.01),
      emissionAt(70),
      emissionAt(70.01),
      emissionAt(90),
      emissionAt(90.01),
      emissionAt(100),
      emissionAt(100.01),
    ].map(({ band, modifier }) => ({ band, modifier }))).toEqual([
      { band: "dark", modifier: 4 },
      { band: "dark", modifier: 4 },
      { band: "minimal", modifier: 3 },
      { band: "minimal", modifier: 3 },
      { band: "reduced", modifier: 1 },
      { band: "reduced", modifier: 1 },
      { band: "normal", modifier: 0 },
      { band: "normal", modifier: 0 },
      { band: "high", modifier: -2 },
      { band: "high", modifier: -2 },
      { band: "redline", modifier: -4 },
    ]);

    const thermalAt = (heat) => {
      const input = clone(state);
      input.heat = heat;
      return getCurrentSignature(config, input).thermal;
    };
    expect([
      thermalAt(30),
      thermalAt(30.01),
      thermalAt(65),
      thermalAt(65.01),
      thermalAt(100),
      thermalAt(100.01),
    ].map(({ band, modifier }) => ({ band, modifier }))).toEqual([
      { band: "cold", modifier: 0 },
      { band: "hot", modifier: -2 },
      { band: "hot", modifier: -2 },
      { band: "overheating", modifier: -5 },
      { band: "overheating", modifier: -5 },
      { band: "overflow", modifier: -10 },
    ]);
  });

  test("passive detection includes exact maximum range but never sees through blocked LOS", () => {
    const observer = freshShip();
    const target = freshShip();
    const base = {
      targetUuid: "target",
      observerConfig: observer.config,
      observerState: clone(observer.state),
      targetConfig: target.config,
      targetState: clone(target.state),
      targetSignature: 10,
      distance: 100,
    };

    const boundary = passiveDetection({ ...base, sensorLineOfSight: true });
    expect(boundary).toMatchObject({ detected: true, inRange: true, blocked: false, total: 10 });

    const blocked = passiveDetection({ ...base, sensorLineOfSight: false });
    expect(blocked).toMatchObject({ detected: false, reason: "blocked", inRange: true, blocked: true });
  });

  test("tracks belong to the observer and loss clears targeted-only revelations", () => {
    const observer = freshShip();
    const target = freshShip();
    const targetBefore = clone(target.state);
    const observation = {
      targetUuid: "target",
      targetConfig: target.config,
      targetState: target.state,
      targetSignature: 10,
      distance: 100,
      sensorLineOfSight: true,
      position: { x: 4, y: -20 },
      facing: 15,
      velocity: { x: 2, y: 1 },
      effectiveAc: 17,
      defenses: { armor: { fore: 3 } },
      systems: { damagedSystems: ["sensor"] },
    };

    const refreshed = refreshObserverTracks({
      observerConfig: observer.config,
      observerState: observer.state,
      targets: [clone(observation)],
    });
    expect(refreshed.acquired).toEqual(["target"]);
    expect(observer.state.tracks.target.state).toBe(TRACK_STATUS.CONTACT);
    expect(target.state).toEqual(targetBefore);
    expect(target.state.tracks).toEqual({});

    acquireTarget(observer.state, {
      config: observer.config,
      targetUuid: "target",
      distance: 100,
      sensorLineOfSight: true,
      telemetry: clone(observation),
    });
    analyzeDefenses(observer.state, {
      config: observer.config,
      targetUuid: "target",
      distance: 100,
      sensorLineOfSight: true,
      telemetry: clone(observation),
    });
    deepScan(observer.state, {
      config: observer.config,
      targetUuid: "target",
      distance: 100,
      sensorLineOfSight: true,
      identifiedSubsystems: ["sensor"],
      telemetry: clone(observation),
    });
    calculateFiringSolution(observer.state, {
      config: observer.config,
      targetUuid: "target",
      distance: 100,
      sensorLineOfSight: true,
    });
    expect(observer.state.tracks.target).toMatchObject({
      state: TRACK_STATUS.TARGETED,
      defensesRevealed: true,
      systemsRevealed: true,
      firingSolution: true,
      knownVelocity: { x: 2, y: 1 },
      effectiveAc: 17,
    });

    const lost = refreshObserverTracks({
      observerConfig: observer.config,
      observerState: observer.state,
      targets: [{ ...clone(observation), sensorLineOfSight: false }],
    });
    expect(lost.lost).toEqual(["target"]);
    expect(observer.state.tracks.target).toMatchObject({
      state: TRACK_STATUS.UNDETECTED,
      defensesRevealed: false,
      systemsRevealed: false,
      firingSolution: false,
      lastKnown: { stale: true },
    });
    for (const key of ["knownVelocity", "effectiveAc", "defenses", "systems"]) {
      expect(Object.hasOwn(observer.state.tracks.target, key)).toBe(false);
    }
    expect(target.state).toEqual(targetBefore);
  });

  test("deep scan reveals named subsystem choices without retaining private component fields", () => {
    const observer = freshShip();
    observer.state.tracks.target = { targetUuid: "target", state: TRACK_STATUS.TARGETED, remembered: {} };
    const input = {
      config: observer.config,
      targetUuid: "target",
      distance: 10,
      sensorLineOfSight: true,
      identifiedSubsystems: [{ id: "sensor", label: "Longview Array", class: "sensor", regions: ["fore"], secret: "private" }],
    };
    observer.state.tracks.target.systems = { installedWeapons: input.identifiedSubsystems };

    expect(sanitizeTrack({ observerState: observer.state, targetUuid: "target" }).remembered?.identifiedSubsystems).toBeUndefined();
    expect(sanitizeTrack({ observerState: observer.state, targetUuid: "target" }).systems).toBeUndefined();
    deepScan(observer.state, input);
    const scanned = sanitizeTrack({ observerState: observer.state, targetUuid: "target" });
    expect(scanned.remembered.identifiedSubsystems).toEqual([
      { id: "sensor", label: "Longview Array", class: "sensor", regions: ["fore"] },
    ]);
    expect(scanned.systemsRevealed).toBe(true);

    deepScan(observer.state, { ...input, identifiedSubsystems: ["sensor", "legacy-drive"] });
    expect(sanitizeTrack({ observerState: observer.state, targetUuid: "target" }).remembered.identifiedSubsystems).toEqual([
      { id: "sensor", label: "Longview Array", class: "sensor", regions: ["fore"] },
      "legacy-drive",
    ]);
  });

  test("active Ping rolls once for the whole declared target set", () => {
    const source = freshShip();
    const first = freshShip();
    const second = freshShip();
    source.state.phase = "active";
    source.state.resources.actions[GUNNER] = 1;
    const ships = {
      source: { config: source.config, state: source.state, token: { x: 0, y: 0 } },
      first: { config: first.config, state: first.state, token: { x: 0, y: -10 } },
      second: { config: second.config, state: second.state, token: { x: 0, y: -20 } },
    };
    const operation = {
      type: "ping",
      sourceUuid: "source",
      targetUuids: ["first", "second"],
      expectedRevisions: { source: 0, first: 0, second: 0 },
      payload: { operatorId: GUNNER },
    };
    const inputShips = clone(ships);
    const inputBefore = clone(inputShips);
    let rolls = 0;
    const result = executeShipOperation(clone(operation), {
      ships: inputShips,
      rollD20: () => {
        rolls += 1;
        return 7;
      },
    });

    expect(rolls).toBe(1);
    expect(result.publicEvents).toEqual([]);
    expect(result.gmEvents[0].detail).toMatchObject({ roll: 7, signatureSpikeApplied: true });
    expect(result.gmEvents[0].detail.detected.map(({ targetUuid }) => targetUuid)).toEqual(["first", "second"]);
    expect(result.shipStates.source.tracks).toMatchObject({
      first: { state: TRACK_STATUS.CONTACT },
      second: { state: TRACK_STATUS.CONTACT },
    });
    expect(result.shipStates.source.resources.actions[GUNNER]).toBe(0);
    expect(inputShips).toEqual(inputBefore);
  });

  test("a firing solution is a one-use bonus", () => {
    const { config, state } = freshShip();
    state.tracks.target = {
      targetUuid: "target",
      state: TRACK_STATUS.TARGETED,
      passiveContact: true,
      firingSolution: false,
      remembered: {},
      jams: [],
    };
    calculateFiringSolution(state, {
      config,
      targetUuid: "target",
      distance: 50,
      sensorLineOfSight: true,
    });

    expect(consumeFiringSolution(state, "target")).toEqual({
      targetUuid: "target",
      consumed: true,
      modifier: 4,
    });
    expect(state.tracks.target.firingSolution).toBe(false);
    expectViolation(() => consumeFiringSolution(state, "target"), "SENSOR_FIRING_SOLUTION_NOT_READY");
  });

  test("Jam, Burn Through, and Break Lock mutate only the defending observer's track", () => {
    const attacker = freshShip();
    const defender = freshShip();
    attacker.state.tracks.defender = {
      targetUuid: "defender",
      state: TRACK_STATUS.CONTACT,
      passiveContact: true,
      remembered: {},
      jams: [],
    };
    defender.state.tracks.attacker = {
      targetUuid: "attacker",
      state: TRACK_STATUS.TARGETED,
      passiveContact: true,
      defensesRevealed: true,
      systemsRevealed: true,
      firingSolution: true,
      knownVelocity: { x: 3, y: 0 },
      effectiveAc: 18,
      defenses: { armor: 3 },
      systems: { damagedSystems: ["drive"] },
      remembered: {},
      jams: [],
    };

    const jam = jamTarget({
      actingConfig: attacker.config,
      actingState: attacker.state,
      actingUuid: "attacker",
      targetConfig: defender.config,
      targetState: defender.state,
      targetUuid: "defender",
      distance: 10,
      sensorLineOfSight: true,
      operatorSensors: 5,
      d20: 20,
    });
    expect(jam.success).toBe(true);
    expect(attacker.state.tracks.defender.jams).toEqual([]);
    expect(defender.state.tracks.attacker.jams).toEqual([
      { sourceUuid: "attacker", modifier: -4, untilTurnKey: true, active: true },
    ]);

    const burned = burnThrough({
      actingConfig: defender.config,
      actingState: defender.state,
      actingUuid: "defender",
      jammerConfig: attacker.config,
      jammerState: attacker.state,
      jammerUuid: "attacker",
      distance: 10,
      sensorLineOfSight: true,
      operatorSensors: 5,
      d20: 20,
    });
    expect(burned).toMatchObject({ success: true, removed: true, jammerUuid: "attacker" });
    expect(defender.state.tracks.attacker.jams).toEqual([]);

    const broken = breakLock({
      actingConfig: attacker.config,
      actingState: attacker.state,
      actingUuid: "attacker",
      targetConfig: defender.config,
      targetState: defender.state,
      targetUuid: "defender",
      distance: 10,
      sensorLineOfSight: true,
      operatorSensors: 5,
      d20: 20,
      passiveSupported: false,
    });
    expect(broken).toMatchObject({ success: true, broken: true, resultingState: TRACK_STATUS.UNDETECTED });
    expect(defender.state.tracks.attacker).toMatchObject({
      state: TRACK_STATUS.UNDETECTED,
      defensesRevealed: false,
      systemsRevealed: false,
      firingSolution: false,
    });
    for (const key of ["knownVelocity", "effectiveAc", "defenses", "systems"]) {
      expect(Object.hasOwn(defender.state.tracks.attacker, key)).toBe(false);
    }
  });

  test("sanitized telemetry exposes only state-appropriate Undetected, Contact, and Targeted knowledge", () => {
    const undetected = sanitizeTrack({
      targetUuid: "unknown",
      track: {
        state: TRACK_STATUS.UNDETECTED,
        remembered: { label: "Faded contact", secret: "gm-only" },
        lastKnown: { position: { x: 1, y: 2 }, stale: true, secret: "gm-only" },
        knownVelocity: { x: 9, y: 9 },
        effectiveAc: 99,
        defenses: { armor: 99 },
        systems: { secret: true },
      },
    });
    expect(undetected).toEqual({
      targetUuid: "unknown",
      state: TRACK_STATUS.UNDETECTED,
      remembered: { label: "Faded contact" },
      lastKnown: { position: { x: 1, y: 2 }, stale: true },
    });

    const contact = sanitizeTrack({
      targetUuid: "contact",
      track: {
        state: TRACK_STATUS.CONTACT,
        remembered: {
          label: "Bogey",
          secret: "gm-only",
          identity: { id: "known-id", secret: "gm-only" },
          componentIds: [1],
          identifiedSubsystems: [{ id: "drive", label: "Drive", secret: "gm-only" }],
        },
        lastKnown: { position: { x: 2, y: 3 }, facing: 90, stale: true, secret: "gm-only" },
        knownVelocity: { x: 9, y: 9 },
        effectiveAc: 99,
        defenses: { armor: 99 },
        systems: { secret: true },
      },
    });
    expect(contact).toEqual({
      targetUuid: "contact",
      state: TRACK_STATUS.CONTACT,
      remembered: {
        label: "Bogey",
        identity: { id: "known-id" },
        componentIds: ["1"],
        identifiedSubsystems: [{ id: "drive", label: "Drive" }],
      },
      lastKnown: { position: { x: 2, y: 3 }, facing: 90, stale: true },
    });

    const targeted = sanitizeTrack({
      targetUuid: "targeted",
      track: {
        state: TRACK_STATUS.TARGETED,
        remembered: {},
        defensesRevealed: true,
        systemsRevealed: true,
        firingSolution: true,
      },
      telemetry: {
        velocity: { x: 4, y: -1 },
        effectiveAc: "17",
        defenses: {
          currentShields: 8,
          armor: { fore: 3 },
          secret: "gm-only",
          shields: {
            current: 8,
            capacity: 24,
            hp: { fore: 8 },
            allocation: { fore: 24 },
            topology: "sector",
            secret: "gm-only",
            charge: { fore: 8 },
          },
        },
        systems: {
          damagedSystems: ["sensor"],
          installedWeapons: ["railgun"],
          secret: "gm-only",
        },
      },
    });
    expect(targeted).toMatchObject({
      targetUuid: "targeted",
      state: TRACK_STATUS.TARGETED,
      knownVelocity: { x: 4, y: -1 },
      effectiveAc: 17,
      defensesRevealed: true,
      systemsRevealed: true,
      firingSolution: true,
      defenses: {
        currentShields: 8,
        armor: { fore: 3 },
        shields: {
          current: 8,
          capacity: 24,
          hp: { fore: 8 },
          allocation: { fore: 24 },
          topology: "sector",
        },
      },
      systems: { damagedSystems: ["sensor"], installedWeapons: ["railgun"] },
    });
    expect(Object.hasOwn(targeted.defenses, "secret")).toBe(false);
    expect(Object.hasOwn(targeted.defenses.shields, "secret")).toBe(false);
    expect(Object.hasOwn(targeted.defenses.shields, "charge")).toBe(false);
    expect(Object.hasOwn(targeted.systems, "secret")).toBe(false);
  });
});

describe("attack previews, commitment, and damage", () => {
  test("preview exposes arc, range, and relative motion without leaking GM attack data", () => {
    const { attacker, target, declaration } = prepareAttack({ targetPosition: { x: 0, y: -60 } });
    declaration.targetVelocity = { x: 4, y: 0 };
    const preview = previewAttack({
      attackerConfig: attacker.config,
      attackerState: clone(attacker.state),
      targetConfig: target.config,
      targetState: clone(target.state),
      declaration: clone(declaration),
    });

    expect(preview.legal).toBe(true);
    expect(preview.public).toMatchObject({
      arcValid: true,
      rangeValid: true,
      struckSector: "aft",
      range: { band: "optimal", modifier: 0 },
      relativeMotion: { transverseSpeed: 4, radialSpeed: 0, effectiveMotion: 3, band: ">2-4", modifier: 1 },
    });
    expect(Object.hasOwn(preview.public, "geometry")).toBe(false);
    expect(Object.hasOwn(preview.public, "actualTargetAc")).toBe(false);
    expect(Object.hasOwn(preview.public, "damageProfile")).toBe(false);
    expect(preview.gm).toMatchObject({ actualTargetAc: 14, geometry: { distance: 60, arcValid: true, rangeValid: true } });
    expect(preview.gm.attack.profile.damage).toEqual({ shield: 4, hull: 12, heat: 0 });

    const outOfArc = previewAttack({
      attackerConfig: attacker.config,
      attackerState: clone(attacker.state),
      targetConfig: target.config,
      targetState: clone(target.state),
      declaration: { ...clone(declaration), targetPosition: { x: 60, y: 0 } },
    });
    expect(outOfArc.legal).toBe(false);
    expect(outOfArc.violations.map(({ code }) => code)).toContain("TARGET_OUT_OF_ARC");
  });

  test("preview itemizes every term behind the group totals the console renders", () => {
    const { attacker, target, declaration } = prepareAttack({
      weaponId: CANADENSIS_IDS.portMacrocannon,
      targetPosition: { x: -30, y: 0 },
      firingSolution: true,
    });
    target.state.velocity = { x: 0, y: 4 };
    const preview = previewAttack({
      attackerConfig: attacker.config,
      attackerState: clone(attacker.state),
      targetConfig: target.config,
      targetState: clone(target.state),
      declaration: { ...clone(declaration), barrageRounds: 6 },
    });

    expect(preview.legal).toBe(true);
    const groups = preview.public.modifiers;
    expect(groups.map((group) => group.id)).toEqual([
      "gunnery",
      "weapon",
      "range",
      "relativeMotion",
      "sensors",
      "special",
    ]);
    for (const group of groups) {
      expect(group.items.map((item) => item.value)).not.toHaveLength(0);
      expect(group.items.reduce((sum, item) => sum + item.value, 0))
        .toBe(preview.public.categories[group.id]);
    }
    const items = groups.flatMap((group) => group.items);
    expect(items.reduce((sum, item) => sum + item.value, 0))
      .toBe(preview.public.knownModifierTotal);
    // The two terms players ask about most must be named, not folded into a group.
    expect(items).toContainEqual({
      id: "firingSolution",
      label: "Firing solution",
      value: 4,
    });
    expect(items).toContainEqual({
      id: "barrage",
      label: "Barrage ×6",
      value: -3,
    });
    expect(groups.find((group) => group.id === "gunnery").items).toEqual([
      expect.objectContaining({ id: "gunneryRating", value: 5 }),
    ]);
  });

  test.each([
    ["main", 0, "aft", "driveFailure"],
    ["reverse", 180, "fore", "driveFailure"],
    ["portLateral", -90, "port", "maneuveringThrusterFailure"],
    ["starboardLateral", 90, "starboard", "maneuveringThrusterFailure"],
  ])("aimed shots can select the installed %s drive in its struck region", (role, targetFacing, sector, channel) => {
    const { attacker, target, declaration } = prepareAttack({ firingSolution: true, targetFacing });
    const drive = target.config.components.drives[role];
    attacker.state.tracks.target.remembered.identifiedSubsystems = [drive.id];
    declaration.aimedComponentId = drive.id;

    const preview = previewAttack({
      attackerConfig: attacker.config,
      attackerState: attacker.state,
      targetConfig: target.config,
      targetState: target.state,
      declaration,
    });

    expect(preview.legal).toBe(true);
    expect(preview.violations).toEqual([]);
    expect(preview.public.struckSector).toBe(sector);
    expect(preview.commitment.aimedConditionId).toBe(`${drive.id}:${channel}`);
  });

  test("aimed drive shots still require identification, a regional condition target, and a ready Firing Solution", () => {
    const { attacker, target, declaration } = prepareAttack({ firingSolution: true });
    const drive = target.config.components.drives.main;
    const track = attacker.state.tracks.target;
    declaration.aimedComponentId = drive.id;
    const preview = (changes = {}) => previewAttack({
      attackerConfig: attacker.config,
      attackerState: attacker.state,
      targetConfig: target.config,
      targetState: target.state,
      declaration: { ...declaration, ...changes },
    });
    const expectRejected = (result, code) => {
      expect(result.legal).toBe(false);
      expect(result.commitment).toBeNull();
      expect(result.violations.map((violation) => violation.code)).toEqual([code]);
    };

    expectRejected(preview(), "AIMED_COMPONENT_UNKNOWN");
    track.remembered.identifiedSubsystems = [drive.id];
    expectRejected(preview({ targetFacing: 180 }), "AIMED_COMPONENT_OUT_OF_REGION");
    expectRejected(preview({ aimedComponentId: "uninstalled-drive" }), "INVALID_AIMED_COMPONENT");

    track.firingSolution = false;
    expectRejected(preview(), "AIMED_SHOT_REQUIRES_SOLUTION");
    track.firingSolution = true;
    target.state.conditions.destroyedDrive = {
      componentId: drive.id,
      conditionId: "driveFailure",
      severity: "destroyed",
    };
    expectRejected(preview(), "AIMED_COMPONENT_DESTROYED");
  });

  test("armed Evasion applies the configured AC bonus to attack previews", () => {
    const { attacker, target, declaration } = prepareAttack();
    target.state.evasion = { armed: true, reserved: 0.2 };
    target.config.evasionAcBonus = 3;

    const preview = previewAttack({
      attackerConfig: attacker.config,
      attackerState: clone(attacker.state),
      targetConfig: target.config,
      targetState: clone(target.state),
      declaration: clone(declaration),
    });

    expect(preview.public.finalAc).toBe(target.config.ac + 3);
    expect(preview.gm.actualTargetAc).toBe(target.config.ac + 3);
  });

  test("stale declarations and post-spend roll failures are atomic", () => {
    const { attacker, target, declaration } = prepareAttack({ firingSolution: true });
    const attackerBefore = clone(attacker.state);
    const targetBefore = clone(target.state);
    let rolls = 0;

    expectViolation(() => commitAttack({
      attackerConfig: attacker.config,
      attackerDraft: attacker.state,
      targetConfig: target.config,
      targetDraft: target.state,
      declaration: { ...clone(declaration), expectedAttackerRevision: attacker.state.revision + 1 },
      rollD20: () => {
        rolls += 1;
        return 10;
      },
    }), "ILLEGAL_ATTACK_DECLARATION");
    expect(rolls).toBe(0);
    expect(attacker.state).toEqual(attackerBefore);
    expect(target.state).toEqual(targetBefore);

    expectViolation(() => commitAttack({
      attackerConfig: attacker.config,
      attackerDraft: attacker.state,
      targetConfig: target.config,
      targetDraft: target.state,
      declaration: clone(declaration),
      rollD20: () => 0,
    }), "INVALID_D20");
    expect(attacker.state).toEqual(attackerBefore);
    expect(target.state).toEqual(targetBefore);
  });

  test("dispatcher rejects a stale operation without spending or mutating request snapshots", () => {
    const source = freshShip();
    const target = freshShip();
    source.state.phase = "active";
    source.state.resources.actions[GUNNER] = 1;
    const operation = {
      type: "ping",
      sourceUuid: "source",
      targetUuids: ["target"],
      expectedRevisions: { source: 1, target: 0 },
      payload: { operatorId: GUNNER },
    };
    const ships = {
      source: { config: source.config, state: source.state, token: { x: 0, y: 0 } },
      target: { config: target.config, state: target.state, token: { x: 0, y: -10 } },
    };
    const before = clone({ operation, ships });

    expectViolation(() => executeShipOperation(operation, { ships, rollD20: () => 20 }), "STALE_SHIP_REVISION");
    expect({ operation, ships }).toEqual(before);
    expect(source.state.resources.actions[GUNNER]).toBe(1);
  });

  test("natural 1 always misses and natural 20 always produces at least one capped hit", () => {
    expect(calculateEffectiveHits(1, 100, 14, BARRAGE_PROFILES[10])).toBe(0);
    expect(calculateEffectiveHits(20, -100, 14, BARRAGE_PROFILES[10])).toBe(1);
    expect(calculateEffectiveHits(20, 100, 14, BARRAGE_PROFILES[4])).toBe(2);
  });

  test("Barrage spends physical rounds once and resolves effective projectiles sequentially", () => {
    const { attacker, target, declaration } = prepareAttack({
      weaponId: CANADENSIS_IDS.portMacrocannon,
      targetPosition: { x: -30, y: 0 },
      targetFacing: 90,
      firingSolution: true,
    });
    declaration.barrageRounds = 4;
    target.state.shields.hp.fore = 8;
    const result = commitAttack({
      attackerConfig: attacker.config,
      attackerDraft: attacker.state,
      targetConfig: target.config,
      targetDraft: target.state,
      declaration: clone(declaration),
      rollD20: () => 19,
    });

    expect(result.gm.roll).toMatchObject({ natural: 19, hit: true, effectiveHits: 2 });
    expect(result.gm.commitment.barrage).toEqual({ rounds: 4, penalty: -2, maximumEffectiveHits: 2 });
    expect(attacker.state.weapons[CANADENSIS_IDS.portMacrocannon].readiness).toBe(16);
    expect(attacker.state.heat).toBe(4);
    expect(attacker.state.resources.actions[GUNNER]).toBe(0);
    expect(attacker.state.tracks.target.firingSolution).toBe(false);
    expect(result.gm.damage.projectiles).toHaveLength(2);
    expect(result.gm.damage.projectiles[0]).toMatchObject({
      shield: { activeBefore: 8, after: 2, collapsed: false },
      hull: { transmitted: 0, taken: 0 },
    });
    expect(result.gm.damage.projectiles[1]).toMatchObject({
      shield: { activeBefore: 2, after: 0, collapsed: true },
      armor: { base: 3, piercing: 1, effective: 2 },
      hull: { listed: 8, transmitted: 5, taken: 3, before: 50, after: 47 },
    });
    expect(target.state.hull).toBe(47);
    expect(Object.hasOwn(result.public.damage, "projectiles")).toBe(false);
    expect(Object.hasOwn(result.public.damage, "totals")).toBe(false);
    expect(result.gm.damage.totals).toEqual({ hullDamage: 3, heatDamage: 0 });
  });

  test("a projectile resolves shield breakthrough, Armor, Hull, then Heat in order", () => {
    const target = freshShip();
    target.state.shields.hp.fore = 2;
    target.state.hull = 50;
    target.state.heat = 1;
    const result = resolveProjectile(target.config, target.state, {
      sector: "fore",
      damage: { shield: 6, hull: 8, heat: 6 },
      armorPiercing: 1,
    });

    expect(result.gm).toMatchObject({
      shield: { before: 2, activeBefore: 2, damage: 6, after: 0, collapsed: true },
      armor: { base: 3, piercing: 1, effective: 2 },
      hull: { listed: 8, transmitted: 5, taken: 3, before: 50, after: 47 },
      heat: { listed: 6, transmitted: 4, before: 1, after: 5 },
    });
    expect(result.gm.breakthrough.fraction).toBeCloseTo(2 / 3);
    expect(target.state).toMatchObject({ hull: 47, heat: 5, shields: { hp: { fore: 0 } } });
    expect(result.public).toEqual({ sector: "fore", shieldCollapsed: true, hullReachedZero: false });
    expect(Object.hasOwn(result.public, "armor")).toBe(false);
  });

  test("damage consumes shield hp without touching the allocation ceiling", () => {
    const target = freshShip();
    target.state.shields.hp.fore = 2;
    const result = resolveProjectile(target.config, target.state, {
      sector: "fore",
      damage: { shield: 6, hull: 8, heat: 0 },
      armorPiercing: 0,
    });

    expect(result.gm.shield).toMatchObject({ activeBefore: 2, after: 0, collapsed: true });
    expect(target.state.shields.hp.fore).toBe(0);
    expect(target.state.shields.allocation.fore).toBe(15);
    expect(target.state.shields.collapse.fore).toBe(target.config.components.shield.rechargeDelay);
  });

  test("shieldless damage on an empty loadout reaches Hull without degraded-state errors", () => {
    const target = freshShip();
    target.config.components = { drives: {}, weapons: [] };
    target.config.weaponPriority = [];
    target.state = createInitialState(target.config);

    const result = resolveProjectile(target.config, target.state, {
      sector: "fore",
      damage: { shield: 20, hull: 8, heat: 0 },
      armorPiercing: 3,
    });

    expect(result.gm).toMatchObject({
      shield: { active: false, activeBefore: 0, after: 0, collapsed: false },
      breakthrough: { fraction: 1, hullFraction: 1 },
      hull: { listed: 8, transmitted: 8, taken: 8, before: 50, after: 42 },
    });
    expect(target.state.hull).toBe(42);
  });

  test("natural-20 criticals deterministically select and then escalate the same condition", () => {
    const target = freshShip();
    target.state.power.shields = 0;
    target.state.shields.hp.fore = 0;
    const helpers = { applyConditionTiers, selectCondition };
    const attack = {
      effectiveHits: 1,
      naturalRoll: 20,
      sector: "fore",
      damage: { shield: 0, hull: 4, heat: 0 },
      armorPiercing: 0,
      traits: [],
    };

    const first = resolveAttack(target.config, target.state, { ...clone(attack), random: () => 0 }, helpers);
    const conditionKey = first.gm.conditionEvent.applications[0].key;
    expect(first.gm.conditionEvent).toMatchObject({
      kind: "critical",
      critical: true,
      aimed: false,
      tiers: 1,
      applications: [{ before: "healthy", after: "minor", applied: 1 }],
    });
    expect(target.state.conditions[conditionKey]).toMatchObject({
      kind: "fault",
      channelId: "weaponMalfunction",
      componentId: CANADENSIS_IDS.railgun,
      severity: "minor",
    });
    expect(target.config.components.weapons.some(({ id }) => id === CANADENSIS_IDS.railgun)).toBe(true);

    const second = resolveAttack(target.config, target.state, { ...clone(attack), random: () => 0 }, helpers);
    expect(second.gm.conditionEvent.applications).toMatchObject([
      { key: conditionKey, before: "minor", after: "major", applied: 1 },
    ]);
    expect(target.state.conditions[conditionKey]).toMatchObject({
      componentId: CANADENSIS_IDS.railgun,
      severity: "major",
    });
  });

  test("a Hazard escalates only on its second End processing", () => {
    const target = freshShip();
    applyConditionTiers(target.config, target.state, {
      conditionId: "fire:fore",
      tiers: 1,
      sector: "fore",
      random: () => 0,
    });
    expect(target.state.conditions["fire:fore"]).toMatchObject({ severity: "minor", clock: 2 });

    const firstEnd = processHazardEnd(target.config, target.state, { random: () => 0, endKey: "one" });
    expect(target.state.conditions["fire:fore"]).toMatchObject({ severity: "minor", clock: 1 });
    expect(firstEnd.events.some(({ type }) => type === "hazardEscalation")).toBe(false);

    const secondEnd = processHazardEnd(target.config, target.state, { random: () => 0, endKey: "two" });
    expect(target.state.conditions["fire:fore"]).toMatchObject({ severity: "major", clock: 2 });
    expect(secondEnd.events).toContainEqual({
      type: "hazardEscalation",
      conditionId: "fire:fore",
      before: "minor",
      after: "major",
      clock: 2,
    });
  });

  test("automatic readiness and manual reload complete through their distinct transitions", () => {
    const ship = freshShip();
    ship.state.weapons[CANADENSIS_IDS.railgun].status = "online";
    ship.state.weapons[CANADENSIS_IDS.railgun].readiness = 0;
    const automatic = advanceWeaponRecovery(ship.config, ship.state, { weaponId: CANADENSIS_IDS.railgun });
    expect(automatic.public).toMatchObject({
      eligible: true,
      recovered: 1,
      before: 0,
      after: 1,
      complete: true,
    });
    expect(ship.state.weapons[CANADENSIS_IDS.railgun]).toMatchObject({ readiness: 1, reloadProgress: 0 });

    ship.state.weapons[CANADENSIS_IDS.portMacrocannon].readiness = 19;
    const begun = beginWeaponReload(ship.config, ship.state, { weaponId: CANADENSIS_IDS.portMacrocannon });
    expect(begun.public).toMatchObject({ started: true, current: 0, required: 1, readiness: 19 });
    expect(ship.state.weapons[CANADENSIS_IDS.portMacrocannon].reloadWork).toEqual({ current: 0, baseRequired: 1, required: 1 });

    const completed = contributeWeaponReload(ship.config, ship.state, {
      weaponId: CANADENSIS_IDS.portMacrocannon,
      amount: 1,
    });
    expect(completed.public).toMatchObject({ amount: 1, current: 1, required: 1, complete: true, before: 19, after: 20 });
    expect(ship.state.weapons[CANADENSIS_IDS.portMacrocannon]).toMatchObject({ readiness: 20, reloadWork: null });
  });

  test("Non-Lethal zero Hull resolves fate as disabled instead of pending or destroyed", () => {
    const target = freshShip();
    target.state.power.shields = 0;
    target.state.shields.hp.fore = 0;
    target.state.hull = 2;
    const result = resolveAttack(target.config, target.state, {
      effectiveHits: 1,
      naturalRoll: 10,
      sector: "fore",
      damage: { shield: 0, hull: 10, heat: 0 },
      armorPiercing: 0,
      traits: [{ id: "nonLethal" }],
    });

    expect(target.state.hull).toBe(0);
    expect(target.state.pendingFate).toEqual({
      status: "resolved",
      outcome: "disabled",
      reason: "nonLethal",
      triggeringProjectile: 0,
    });
    expect(result.public.fate).toEqual(target.state.pendingFate);
    expect(result.gm.fate).toEqual(target.state.pendingFate);
    expect(Object.hasOwn(result.public, "projectiles")).toBe(false);
    expect(result.gm.projectiles).toHaveLength(1);
  });
});
