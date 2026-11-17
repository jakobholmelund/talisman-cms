/** Resumable setup: create variants once, then record all opening counts in one audited stocktake. */
export type SetupPlan = {
  create: {
    action: "createOptionSet" | "addOptionValues";
    groupId?: string;
    expectedUpdatedAt?: string | number;
    productId: string;
    requestKey: string;
    name?: string;
    values: string[];
    images: (string | null)[];
  };
  quantities: number[];
  groupId?: string;
  stockRequest?: Record<string, unknown>;
  complete?: boolean;
};
type Request = (path: string, body: unknown) => Promise<any>;
export async function finishProductSetup(plan: SetupPlan, request: Request) {
  if (plan.complete) return;
  if (!plan.groupId) {
    const response = await request("variants", plan.create);
    if (
      typeof response?.result?.groupId !== "string" ||
      !response.result.groupId
    )
      throw new Error(
        "Could not confirm the variants. Retry to recover this same setup.",
      );
    plan.groupId = response.result.groupId;
  }
  if (plan.quantities.some((quantity) => quantity > 0)) {
    if (!plan.stockRequest) {
      const targets = plan.quantities.map((_, index) => ({
        targetType: "stock",
        targetId: `stock_${plan.create.action === "addOptionValues" ? `setup_${plan.create.requestKey}` : plan.groupId}_${index}`,
      }));
      const snapshot = await request("operations", {
        action: "stocktakeRead",
        data: { targets },
      });
      const lines = targets.map((target, index) => {
        const row = snapshot?.rows?.find(
          (row: any) =>
            row.type === target.targetType && row.id === target.targetId,
        );
        if (
          !row ||
          row.quantity !== 0 ||
          typeof row.updatedAt !== "string" ||
          !Number.isFinite(Date.parse(row.updatedAt))
        )
          throw new Error(
            "Starting stock could not be confirmed. Review the saved variants before adding stock.",
          );
        return {
          ...target,
          expectedQuantity: 0,
          expectedUpdatedAt: row.updatedAt,
          countedQuantity: plan.quantities[index],
        };
      });
      // Freeze versions before sending. An unknown response must replay exactly this same receipt.
      plan.stockRequest = {
        action: "stocktake",
        data: {
          requestKey: `opening_${plan.create.requestKey}`,
          reason: "Opening stock entered during product setup",
          lines,
        },
      };
    }
    const receipt = await request("operations", plan.stockRequest);
    if (
      typeof receipt?.result?.stocktakeId !== "string" ||
      !receipt.result.stocktakeId
    )
      throw new Error(
        "Could not confirm starting stock. Retry to recover the same stock receipt.",
      );
  }
  plan.complete = true;
}
