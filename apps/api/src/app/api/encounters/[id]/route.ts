import { NextRequest, NextResponse } from "next/server";
import { getEncounter, upsertEncounter } from "@/lib/store";
import { validateToken, requirePermission } from "@/lib/auth";
import { createAuditEntry } from "@/lib/audit";
import { corsHeaders, corsResponse } from "@/lib/cors";
import { v4 as uuidv4 } from "uuid";
import type { NursingNote } from "@/types";
import { runAggregateDiagnosis } from "@/agents/chains/aggregate-diagnosis-chain";

export async function OPTIONS(req: NextRequest) {
  return corsResponse(req.headers.get("origin"));
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = req.headers.get("origin");
  const { id } = await params;
  const encounter = await getEncounter(id);
  if (!encounter) {
    return NextResponse.json({ error: "Encounter not found" }, { status: 404, headers: corsHeaders(origin) });
  }
  return NextResponse.json({ encounter }, { headers: corsHeaders(origin) });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = req.headers.get("origin");
  const authHeader = req.headers.get("authorization");
  const token = validateToken(authHeader);

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders(origin) });
  }

  if (!requirePermission(token, "nursing_notes") && !requirePermission(token, "triage")) {
    return NextResponse.json({ error: "Forbidden: Requires nursing permissions" }, { status: 403, headers: corsHeaders(origin) });
  }

  const { id } = await params;
  const encounter = await getEncounter(id);
  if (!encounter) {
    return NextResponse.json({ error: "Encounter not found" }, { status: 404, headers: corsHeaders(origin) });
  }

  const body = await req.json();
  const { note, category, triageStatus, vitals } = body;

  if (note) {
    const nursingNote: NursingNote = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      nurseId: token.userId,
      nurseName: token.name,
      note,
      category: category ?? "general",
    };
    encounter.nursingNotes = [...(encounter.nursingNotes ?? []), nursingNote];
    encounter.nurseId = token.userId;
    encounter.nurseName = token.name;

    const audit = createAuditEntry(
      "case_supervisor",
      "NURSING_NOTE",
      `${token.name} added nursing note [${category ?? "general"}]: ${note.substring(0, 100)}`,
      token.userId,
      token.name
    );
    encounter.auditTrail.push(audit);
  }

  if (vitals && typeof vitals === "object") {
    encounter.structuredData = {
      chiefComplaint: encounter.structuredData?.chiefComplaint ?? "",
      observations: encounter.structuredData?.observations ?? [],
      conditions: encounter.structuredData?.conditions ?? [],
      narrative: encounter.structuredData?.narrative ?? "",
      vitals: { ...(encounter.structuredData?.vitals ?? {}), ...vitals },
    };
    const audit = createAuditEntry(
      "case_supervisor", "VITALS_UPDATE",
      `${token.name} updated vitals: ${Object.entries(vitals).map(([k,v]) => `${k}=${v}`).join(", ")}`,
      token.userId, token.name
    );
    encounter.auditTrail.push(audit);
  }

  if (triageStatus) {
    encounter.triageStatus = triageStatus;
    if (triageStatus === "escalated") {
      encounter.status = "needs_doctor_approval";
    }
    const audit = createAuditEntry(
      "case_supervisor",
      "TRIAGE_UPDATE",
      `${token.name} set triage status to: ${triageStatus}`,
      token.userId,
      token.name
    );
    encounter.auditTrail.push(audit);
  }

  // Persist the nursing update first so the SSE broadcast goes out immediately.
  await upsertEncounter(encounter);

  // If the nurse contributed new clinical information, re-aggregate the
  // diagnosis. This runs after the initial upsert so the UI shows the
  // nurse's note instantly while the LLM is still thinking, then updates
  // again when the new diagnosis is ready.
  if (note) {
    runAggregateDiagnosis(encounter)
      .then(async (diagnosis) => {
        encounter.diagnosis = diagnosis;
        encounter.auditTrail.push(
          createAuditEntry(
            "diagnosis", "AGGREGATE_AFTER_NURSE",
            `Re-aggregated diagnosis after nurse note. Primary: ${diagnosis.primary} (conf ${(diagnosis.confidence * 100).toFixed(0)}%).`,
            token.userId, token.name
          )
        );
        await upsertEncounter(encounter);
      })
      .catch((err) => console.error("[patch] aggregate after nurse note failed:", err));
  }

  return NextResponse.json({ encounter }, { headers: corsHeaders(origin) });
}
