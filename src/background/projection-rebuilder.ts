import { materializeProjection } from "../domain/projection-engine";
import type { Env } from "../types";

export class ProjectionRebuilder implements DurableObject {
  constructor(
    _state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const { fileId } = (await request.json()) as { fileId: string };

    await this.env.DB.prepare(
      "UPDATE projections SET rebuild_status = 'rebuilding' WHERE file_id = ?",
    )
      .bind(fileId)
      .run();

    await materializeProjection(this.env, fileId);

    return new Response("ok");
  }
}
