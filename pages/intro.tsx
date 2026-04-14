import React from "react";
import NextLink from "next/link";
import DefaultLayout from "@/layouts/default";

const LINKS = [
  { label: "home", href: "/" },
  { label: "flying", href: "/flying" },
  { label: "projects", href: "/projects" },
];

export default function IntroPage() {
  return (
    <DefaultLayout>
      <div
        className="flex items-center px-6 sm:px-10"
        style={{ minHeight: "calc(100dvh - 4rem)" }}
      >
        <div className="max-w-2xl mx-auto w-full py-12 sm:py-16">
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-medium text-purple dark:text-rose leading-tight mb-8 sm:mb-10">
            Hi, I'm Gennaro.
          </h1>

          <p className="text-base sm:text-lg text-purple/90 dark:text-rose/90 leading-relaxed mb-5">
            Data scientist by title, based in Austin, TX. In practice I
            wander across data, engineering, and whatever else the product
            needs.
          </p>
          <p className="text-base sm:text-lg text-purple/90 dark:text-rose/90 leading-relaxed mb-5">
            I have too many hobbies and refuse to be casual about any of
            them: flying small planes around Texas and Colorado, guitar, a
            handful of others.
          </p>
          <p className="text-base sm:text-lg text-purple/90 dark:text-rose/90 leading-relaxed mb-5">
            Notes from the Underground is my favorite book, if that tells
            you anything.
          </p>
          <p className="text-base sm:text-lg text-purple/70 dark:text-rose/70 leading-relaxed mb-10 sm:mb-12">
            This site is my flight log, photos, and a few projects.
          </p>

          <div className="flex flex-wrap gap-3">
            {LINKS.map((l) => (
              <NextLink
                key={l.href}
                href={l.href}
                className="px-4 py-2 text-sm uppercase tracking-widest border border-darkBorder text-purple dark:text-rose hover:border-gold hover:text-gold transition-colors"
              >
                {l.label}
              </NextLink>
            ))}
          </div>
        </div>
      </div>
    </DefaultLayout>
  );
}
