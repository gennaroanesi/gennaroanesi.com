import { defineStorage } from "@aws-amplify/backend";

export const storage = defineStorage({
  name: "gennaroanesi.com",
  access: (allow) => ({
    "contracts/*": [allow.authenticated.to(["read", "write", "delete"])],
    "pictures/*": [allow.guest.to(["read"])],
  }),
});
