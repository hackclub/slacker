import { Middleware, SlackAction, SlackActionMiddlewareArgs } from "@slack/bolt";
import { StringIndexed } from "@slack/bolt/dist/types/helpers";
import { assign } from "./assign";
import { followUp, snooze } from "./delay";
import { gimmeAgain } from "./gimme";
import { markIrrelevant } from "./irrelevant";
import { notes } from "./notes";
import { resolve } from "./resolve";
import { unsnooze } from "./unsnooze";

export interface ActionHandler
  extends Middleware<SlackActionMiddlewareArgs<SlackAction>, StringIndexed> {}

export { assign, followUp, gimmeAgain, markIrrelevant, notes, resolve, snooze, unsnooze };
