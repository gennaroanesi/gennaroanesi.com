import React from "react";
import DefaultLayout from "@/layouts/default";
import { useTranslation } from "next-i18next";

import type { GetStaticProps } from "next";

import { serverSideTranslations } from "next-i18next/serverSideTranslations";

export default function IndexPage({}) {
  const { t, i18n } = useTranslation("common");

  return (
    <DefaultLayout>
      <div className="relative mt-[-4rem] bg-darkGreen">
        <div className="h-screen bg-cover bg-bottom xl:bg-center bg-no-repeat bg-crisGennaro01">
          <div className="flex flex-col items-center justify-center max-w-full h-full">
            <div className="inline-block align-baseline">
              <h1 className="md:hidden text-center text-[6rem] lg:text-[8rem] xl:text-[10rem] font-FrancieScript text-white">
                At work...
              </h1>
              <h1 className="hidden md:flex text-center text-[6rem] lg:text-[8rem] xl:text-[10rem] font-FrancieScript text-white">
                At work...
              </h1>
            </div>
          </div>
        </div>
      </div>
    </DefaultLayout>
  );
}

export const getStaticProps: GetStaticProps = async ({ locale }) => ({
  props: {
    ...(await serverSideTranslations(locale ?? "en", ["common"], null, [
      "en",
      "pt-BR",
    ])),
  },
});
