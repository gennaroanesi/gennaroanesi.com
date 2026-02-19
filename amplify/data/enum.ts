export const statusEnum = {
    WORKING_HOME: "Working (home)",
    WORKING_OFFICE: "Working (office)",
    TRAVEL: "Travel",
    VACATION: "Vacation",
    WEEKEND_HOLIDAY: "Weekend/Holiday",
    PTO: "PTO",
    CHOICE_DAY: "Choice Day",
}

export type StatusEnumKey = keyof typeof statusEnum;
export type StatusEnumValue = typeof statusEnum[StatusEnumKey];

