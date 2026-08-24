import { createFileRoute } from "@tanstack/react-router";
import { BlogIndex } from "@/components/blog-index";

export const Route = createFileRoute("/docs/")({ component: DocsIndex });

function DocsIndex() {
  return <BlogIndex />;
}
