import { Request, Response } from "express";

export const indexHandler = async (_: Request, res: Response) => {
  res.send("Hello World!");
};
