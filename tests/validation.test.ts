import { describe, expect, it } from "vitest";
import { employeeSchema, fieldErrors, normalizeMobile, validateEmployeeField } from "@/lib/validation";
import { qrPath } from "@/lib/qr-path";

describe("normalizeMobile", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["98765 43210", "+919876543210"],
    ["098765-43210", "+919876543210"],
    ["91 98765 43210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
    ["+1 (415) 555-2671", "+14155552671"],
    ["+44 7911 123456", "+447911123456"],
  ])("accepts %s → %s", (input, expected) => {
    expect(normalizeMobile(input)).toBe(expected);
  });

  it.each(["", "12345", "5876543210", "+91 58765 43210", "+0 123456789", "98765abcde", "+1234567890123456", "call me"])(
    "rejects %s",
    (input) => {
      expect(normalizeMobile(input)).toBeNull();
    },
  );
});

describe("studentSchema / employeeSchema", () => {
  const VALID = {
    name: "Anita Menon",
    sapId: "500123456",
    course: "B.Tech",
    specialization: "Computer Science",
    batch: "2022-2026",
    eventRating: 5,
    contentRelevance: 4,
    suggestions: "Great session",
  };
  const errorsFor = (input: Record<string, unknown>) => {
    const r = employeeSchema.safeParse(input);
    return r.success ? {} : fieldErrors(r.error);
  };

  it("accepts a fully valid form", () => {
    expect(employeeSchema.safeParse(VALID).success).toBe(true);
  });

  it("requires every field: empty → '<Field> is required.'", () => {
    expect(errorsFor({ name: "", sapId: "", course: "", specialization: "", batch: "", eventRating: "", contentRelevance: "" })).toEqual({
      name: "Student Name is required.",
      sapId: "SAP ID is required.",
      course: "Course is required.",
      specialization: "Specialization is required.",
      batch: "Batch is required.",
      eventRating: "Overall event quality rating is required.",
      contentRelevance: "Content relevance rating is required.",
    });
  });

  it.each(["name", "sapId", "course", "specialization", "batch"] as const)(
    "each field is individually required: %s empty / whitespace-only / missing",
    (field) => {
      for (const bad of ["", "   ", "\t \n", undefined]) {
        const errs = errorsFor({ ...VALID, [field]: bad });
        expect(Object.keys(errs)).toEqual([field]);
        expect(errs[field]).toMatch(/is required\.$/);
        expect(validateEmployeeField(field, bad ?? "")).toMatch(/is required\.$/);
      }
    },
  );

  it("too short → 'at least 2 characters'", () => {
    expect(errorsFor({ ...VALID, name: "A" }).name).toBe("Student Name must be at least 2 characters.");
    expect(errorsFor({ ...VALID, course: "X" }).course).toBe("Course must be at least 2 characters.");
  });

  it.each([
    ["name", "Agent 007"],
    ["name", "<script>"],
    ["name", "Anita@Menon"],
    ["course", "Course <b>"],
    ["course", "#1 Course"],
    ["course", "12345"],
    ["specialization", "CS; DROP TABLE"],
    ["specialization", "{AI}"],
    ["specialization", "$$$"],
  ] as const)("rejects clearly invalid %s: %s", (field, value) => {
    expect(errorsFor({ ...VALID, [field]: value })[field]).toBeTruthy();
  });

  it.each([
    ["course", "B.Tech (Honours)"],
    ["course", "M.Tech CSE"],
    ["specialization", "Artificial Intelligence & Data Science"],
    ["specialization", "Cyber Security"],
    ["batch", "2024-2028"],
    ["batch", "Batch-A (2024)"],
    ["name", "D'Souza O'Brien-Nair"],
    ["name", "അനിത മേനോൻ"],
  ] as const)("accepts normal %s text: %s", (field, value) => {
    expect(errorsFor({ ...VALID, [field]: value })).toEqual({});
  });

  it("normalizes whitespace", () => {
    const r = employeeSchema.parse({
      name: "  K.  Ramesh ",
      sapId: " 50098765 ",
      course: " B.Tech ",
      specialization: " Artificial Intelligence ",
      batch: " 2022-2026 ",
      eventRating: 5,
      contentRelevance: 4,
      suggestions: "  Great session!  ",
    });
    expect(r).toEqual({
      name: "K. Ramesh",
      sapId: "50098765",
      course: "B.Tech",
      specialization: "Artificial Intelligence",
      batch: "2022-2026",
      eventRating: 5,
      contentRelevance: 4,
      suggestions: "Great session!",
    });
  });
});

describe("qrPath", () => {
  it("draws one unit square per dark module, offset by the quiet zone", () => {
    expect(qrPath(["10", "01"], 4)).toBe("M4 4h1v1h-1zM5 5h1v1h-1z");
  });
});
