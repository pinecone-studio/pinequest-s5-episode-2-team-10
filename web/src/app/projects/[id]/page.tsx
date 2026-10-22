import { Suspense } from "react";
import ProjectView from "@/components/ProjectView";

export default function ProjectPage() {
  return (
    <Suspense>
      <ProjectView />
    </Suspense>
  );
}
