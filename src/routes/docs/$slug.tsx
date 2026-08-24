import { createFileRoute } from "@tanstack/react-router";
import { BlogArticle } from "@/components/blog-article";

export const Route = createFileRoute("/docs/$slug")({ component: DocsPost });

function DocsPost() {
  const { slug } = Route.useParams();
  return <BlogArticle slug={slug} />;
}
