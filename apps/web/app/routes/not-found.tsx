// Any address no other public route matches. The loader always throws, so the page itself never renders:
// the 404 lands in the public layout's error page, inside the reader shell (as upstream shows it, with the
// phone footer), and the status stays 404.
export function loader() {
  throw new Response("Not found", { status: 404 });
}

export default function NotFound() {
  return null;
}
