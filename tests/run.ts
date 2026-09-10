import { report } from "./_harness";
import { run as indicators } from "./indicators.test";
import { run as structure } from "./structure.test";

indicators();
structure();
report();
