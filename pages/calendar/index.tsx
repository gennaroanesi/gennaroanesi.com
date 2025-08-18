import React from "react";
import DefaultLayout from "@/layouts/default";

import { Calendar, dayjsLocalizer } from "react-big-calendar";
import dayjs from "dayjs";

import "react-big-calendar/lib/css/react-big-calendar.css";

const localizer = dayjsLocalizer(dayjs);

const eventsList = [
  {
    id: 0,
    title: "All Day Event very long title",
    allDay: true,
    start: new Date(2025, 8 - 1, 13),
    end: new Date(2025, 8 - 1, 13),
  },
  {
    id: 1,
    title: "Long Event",
    start: new Date(2025, 8 - 1, 13, 15, 0),
    end: new Date(2025, 8 - 1, 13, 15, 30),
  },

  {
    id: 2,
    title: "DTS STARTS",
    start: new Date(2025, 8 - 1, 13, 16, 0),
    end: new Date(2025, 8 - 1, 13, 17, 30),
  },
];

export default function IndexPage({}) {
  return (
    <DefaultLayout>
      <div className="h-screen">
        <div className="p-4 xl:p-12 m-auto">
          <Calendar
            localizer={localizer}
            events={eventsList}
            startAccessor="start"
            endAccessor="end"
          />
        </div>
      </div>
    </DefaultLayout>
  );
}
