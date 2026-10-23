import { connection, NextResponse } from "next/server";
import { langOf } from "@/lib/i18n";
import { modelStatuses } from "@/lib/server/llm";

/** Which feedback models the folder prototype can use right now. */
export async function GET(request: Request) {
  await connection();
  return NextResponse.json({ models: await modelStatuses(langOf(request)) });
}
