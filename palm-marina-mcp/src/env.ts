import type { ActorNamespace, CloudStorageBucket, KvNamespace } from "@telnyx/edge-runtime";
import type { ViewingCalendar } from "./calendar";

export interface Env {
	CALENDAR: ActorNamespace<ViewingCalendar>;
	CACHE: KvNamespace;
	FILES: CloudStorageBucket;
}
