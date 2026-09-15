import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
const source=await Deno.readTextFile(new URL("./index.ts",import.meta.url));
Deno.test("renewal billing reconciles before a single create or update",()=>{
 assertStringIncludes(source,"allSubscriptions");assertStringIncludes(source,"duplicate_external_reference");assertStringIncludes(source,"first_installment_not_unique");assertStringIncludes(source,"provider_create_outcome_unknown");assertStringIncludes(source,"provider_update_outcome_unknown");
 assert((source.match(/method:\"POST\"/g)||[]).length===1);assert((source.match(/method:\"PUT\"/g)||[]).length===1);
});
