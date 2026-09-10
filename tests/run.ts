import { report } from "./_harness";
import { run as indicators } from "./indicators.test";
import { run as structure } from "./structure.test";
import { run as engine } from "./engine.test";

indicators();
structure();
engine();
report();
