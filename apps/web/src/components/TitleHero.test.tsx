import type { TitleDetailResponse } from "@harbor/shared";
import { render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { describe, expect, it } from "vitest";
import { TitleHero } from "./TitleHero";

const BASE: TitleDetailResponse = {
  id: "a",
  type: "movie",
  title: "Blade Runner",
  originalTitle: null,
  year: 1982,
  overview: "A blade runner must pursue replicants.",
  posterPath: "/p.jpg",
  backdropPath: "/b.jpg",
  runtime: 117,
  genres: ["Science Fiction"],
  tagline: null,
  rating: null,
  logoPath: null,
  director: null,
  writers: [],
  studios: [],
  seasons: [],
  cached: false,
};

function renderHero(detail: TitleDetailResponse): void {
  const ui: JSX.Element = <TitleHero detail={detail} seasonLabel={null} />;
  render(ui);
}

describe("TitleHero", () => {
  it("shows the logo image in the heading when a logoPath exists", () => {
    renderHero({ ...BASE, logoPath: "/logo.png" });
    const heading = screen.getByRole("heading", { level: 1, name: "Blade Runner" });
    // The h1 keeps the title as its accessible name, but renders it as the logo.
    expect(heading.querySelector("img")).not.toBeNull();
  });

  it("shows the text title when there is no logo", () => {
    renderHero(BASE);
    const heading = screen.getByRole("heading", { level: 1, name: "Blade Runner" });
    expect(heading.querySelector("img")).toBeNull();
    expect(heading.textContent).toContain("Blade Runner");
  });

  it("shows the rating in the meta line only when present", () => {
    renderHero({ ...BASE, rating: 6.4 });
    expect(screen.getByText(/★\s*6\.4/)).toBeTruthy();
  });

  it("omits the rating when absent", () => {
    renderHero(BASE);
    expect(screen.queryByText(/★/)).toBeNull();
  });

  it("shows the tagline when present", () => {
    renderHero({ ...BASE, tagline: "More than meets the eye." });
    expect(screen.getByText("More than meets the eye.")).toBeTruthy();
  });
});
