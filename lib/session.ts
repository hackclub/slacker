import { config } from "dotenv";
import type { IronSessionOptions } from "iron-session";
config();

export type User = {
  id: string | undefined;
  token: string | undefined;
};

export const sessionOptions: IronSessionOptions = {
  password: process.env.SECRET_COOKIE_PASSWORD as string,
  cookieName: "user-session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
  },
};

declare module "iron-session" {
  interface IronSessionData {
    user?: User;
  }
}
