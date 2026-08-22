import { useEffect } from "react";
import { VELA_BUILD } from "@/lib/build";

const KEY = "vela-build";

export function PwaRefresh() {
  useEffect(() => {
    localStorage.setItem(KEY, VELA_BUILD);
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    const path = window.location.pathname;
    if (standalone && (path === "/" || path === "/auto" || path === "/live")) {
      window.location.replace("/w");
    }
  }, []);
  return null;
}
