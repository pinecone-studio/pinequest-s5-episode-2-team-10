import { connection, NextResponse } from "next/server";
import { modelStatuses } from "@/lib/server/llm";

/** Which feedback models the folder prototype can use right now. */
export async function GET() {
  await connection();
  return NextResponse.json({ models: await modelStatuses() });
}
