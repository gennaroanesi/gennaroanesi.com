import { defineAuth } from "@aws-amplify/backend";

export const auth = defineAuth({
  loginWith: {
    email: {
      // can be used in conjunction with a customized welcome email as well
      verificationEmailStyle: "CODE",
      verificationEmailSubject: "Welcome to gennaroanesi.com!",
      verificationEmailBody: (createCode) =>
        `Use this code to confirm your account: ${createCode()}`,
      userInvitation: {
        emailSubject: "Welcome to gennaroanesi.com!",
        emailBody: (user, code) =>
          `We're happy to have you! You can now login with username ${user()} and temporary password ${code()}`,
      },
    },
  },
  userAttributes: {
    "custom:full_name": {
      dataType: "String",
      mutable: true,
      minLen: 1,
    },
  },
});
