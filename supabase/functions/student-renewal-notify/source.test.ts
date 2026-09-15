import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
Deno.test("renewal sender validates the public link before exactly one provider submit", () => {
  assertStringIncludes(source, '"get_student_course_renewal_public"');
  assertStringIncludes(source, 'publicData.status !== "PENDING_SIGNATURE"');
  assertStringIncludes(source, '"prepare_student_course_renewal_notification"');
  assertStringIncludes(source, "sendWhatsTextDetailed");
  assertStringIncludes(source, '"finish_student_course_renewal_notification"');
  assert((source.match(/sendWhatsTextDetailed\(/g) || []).length === 1);
});
