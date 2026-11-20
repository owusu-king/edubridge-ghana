import { afterAll, describe, expect, it } from "vitest";
import { getElectiveTakers, setElectiveTakers } from "@/server/assessment/electives";
import { getClassOverview } from "@/server/assessment/report-cards";
import { getScoreSheet, saveScores } from "@/server/assessment/scores";
import { getAssessmentSetup, setupDefaultSubjects } from "@/server/assessment/setup";
import { connect } from "../support/fixtures";
import { billedSchool } from "../support/school";

const conn = connect();
afterAll(() => conn.close());

/** SHS electives (2026-11-18): a level's subject taken only by the students chosen for it. */
describe("elective subjects", () => {
  it("sets up SHS with WASSCE grades and electives, and counts an elective only for its takers", async () => {
    const s = await billedSchool(conn, { stages: ["shs"], levels: ["SHS 1"] });
    await setupDefaultSubjects(conn.app, s.owner);
    const setup = (await getAssessmentSetup(conn.app, s.owner, s.termId))!;
    const shs1 = setup.levels.find((l) => l.name === "SHS 1")!;
    const physics = setup.subjects.find((x) => x.name === "Physics")!;
    const english = setup.subjects.find((x) => x.name === "English Language")!;
    expect(physics.electiveLevelIds).toHaveLength(3);
    expect(physics.electiveLevelIds).toContain(shs1.id);
    expect(english.electiveLevelIds).toEqual([]);
    expect(setup.scales.find((x) => x.stage === "shs")!.bands[0]!.grade).toBe("A1");

    const ama = await s.addStudent("Ama", "Mensah", "SHS 1");
    const kofi = await s.addStudent("Kofi", "Asante", "SHS 1");
    const classId = s.classes["SHS 1"]!;

    // Nobody takes Physics until chosen; English is for everyone.
    expect((await getScoreSheet(conn.app, s.owner, s.termId, classId, physics.id))!.students).toEqual([]);
    expect((await getScoreSheet(conn.app, s.owner, s.termId, classId, english.id))!.students).toHaveLength(2);

    await setElectiveTakers(conn.app, s.owner, {
      termId: s.termId,
      classId,
      subjectId: physics.id,
      studentIds: [ama.id],
    });
    const takers = (await getElectiveTakers(conn.app, s.owner, s.termId, classId, physics.id))!;
    expect(takers.students.filter((x) => x.takes).map((x) => x.id)).toEqual([ama.id]);
    const sheet = (await getScoreSheet(conn.app, s.owner, s.termId, classId, physics.id))!;
    expect(sheet.students.map((x) => x.id)).toEqual([ama.id]);

    // Marks only for takers.
    const cell = (studentId: string, key: string, value: string) => ({ studentId, key, original: "", value });
    await saveScores(conn.app, s.owner, s.termId, classId, physics.id, {
      cells: [cell(ama.id, "class", "40"), cell(ama.id, "exam", "80")],
    });
    await expect(
      saveScores(conn.app, s.owner, s.termId, classId, physics.id, { cells: [cell(kofi.id, "exam", "50")] }),
    ).rejects.toMatchObject({ code: "roster_changed" });

    const summary = (await getClassOverview(conn.app, s.owner, s.termId, classId))!;
    expect(summary.subjects.find((x) => x.id === physics.id)).toMatchObject({ takers: 1, complete: 1 });
    const subjectCount = (id: string) => summary.students.find((x) => x.id === id)!.result.subjectCount;
    expect(subjectCount(ama.id)).toBe(subjectCount(kofi.id) + 1);
  });
});
