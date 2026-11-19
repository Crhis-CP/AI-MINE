// Any address no other page matches, including the pages not rewritten yet. The loader always throws, so the 404
// lands in the layout's error page with the status kept.
export function loader() {
  throw new Response("Not found", { status: 404 });
}

export default function NotFound() {
  return null;
}
