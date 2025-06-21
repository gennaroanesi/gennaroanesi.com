import React, { FormEvent, useState, useEffect } from "react";
import { Link } from "@heroui/link";

const menuItems = {
  data: [
    {
      name: "Beauty",
      href: "admin/data/beauty",
    },
    {
      name: "Food",
      href: "admin/data/food",
    },
    {
      name: "Hotels",
      href: "admin/data/hotels",
    },
    {
      name: "Things to Do",
      href: "admin/data/thingstodo",
    },
  ],
};

export default function LeftMenu() {
  return (
    <div className="p-2">
      <ul className="flex flex-col outline-none w-full">
        <div>
          <h2>Data</h2>
        </div>
        <div className="flex flex-col gap-1 cursor-pointer px-4">
          {menuItems.data.map((item) => (
            <li>
              <Link href={item.href}>{item.name}</Link>
            </li>
          ))}
        </div>
      </ul>
    </div>
  );
}
