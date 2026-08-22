import { describe, expect, it } from "vitest";
import { SyllabusLevelSchema } from "@/lib/contracts";
import { getLevel, getSyllabusLevels, getUnit } from "@/server/syllabus/config";

describe("getSyllabusLevels", () => {
  it("loads and validates every config/syllabus/*.json file against SyllabusLevelSchema", () => {
    const levels = getSyllabusLevels();
    expect(levels.length).toBeGreaterThan(0);
    for (const level of levels) {
      expect(() => SyllabusLevelSchema.parse(level)).not.toThrow();
    }
  });

  it("includes the dyh7 level with all 6 units, each carrying sections/constructions/tareas", () => {
    const dyh7 = getLevel("dyh7");
    expect(dyh7).toBeDefined();
    expect(dyh7?.series).toBe("dicho-y-hecho");
    expect(dyh7?.units).toHaveLength(6);

    for (const unit of dyh7?.units ?? []) {
      expect(unit.sections.length).toBeGreaterThan(0);
      expect(unit.constructions.length).toBeGreaterThanOrEqual(3);
      expect(unit.constructions.length).toBeLessThanOrEqual(6);
      expect(unit.tareas.length).toBeGreaterThanOrEqual(1);
      expect(unit.tareas.length).toBeLessThanOrEqual(2);
    }
  });

  it("gives every unit/section/construction/tarea id that's unique within its own scope", () => {
    const dyh7 = getLevel("dyh7")!;
    const unitIds = dyh7.units.map((u) => u.id);
    expect(new Set(unitIds).size).toBe(unitIds.length);

    for (const unit of dyh7.units) {
      const sectionIds = unit.sections.map((s) => s.id);
      expect(new Set(sectionIds).size).toBe(sectionIds.length);

      const constructionIds = unit.constructions.map((c) => c.id);
      expect(new Set(constructionIds).size).toBe(constructionIds.length);

      const tareaIds = unit.tareas.map((t) => t.id);
      expect(new Set(tareaIds).size).toBe(tareaIds.length);
    }
  });

  it("has every tarea's targetConstructionIds pointing at real constructions of the same unit", () => {
    const dyh7 = getLevel("dyh7")!;
    for (const unit of dyh7.units) {
      const constructionIds = new Set(unit.constructions.map((c) => c.id));
      for (const tarea of unit.tareas) {
        for (const targetId of tarea.targetConstructionIds) {
          expect(constructionIds.has(targetId)).toBe(true);
        }
      }
    }
  });

  it("caches the parsed result across calls", () => {
    expect(getSyllabusLevels()).toBe(getSyllabusLevels());
  });
});

describe("getLevel", () => {
  it("returns undefined for an unknown level id", () => {
    expect(getLevel("does-not-exist")).toBeUndefined();
  });
});

describe("getUnit", () => {
  it("returns the unit for a known level/unit pair", () => {
    const unit = getUnit("dyh7", "u1");
    expect(unit?.title).toBe("Turismo y arqueología maya");
  });

  it("returns undefined for an unknown unit within a known level", () => {
    expect(getUnit("dyh7", "u99")).toBeUndefined();
  });

  it("returns undefined for an unknown level", () => {
    expect(getUnit("does-not-exist", "u1")).toBeUndefined();
  });
});
