export async function runWorkers(tasks, handler, limiter) {
  const results = [];

  await Promise.all(
    tasks.map((task) =>
      limiter.run(async () => {
        const res = await handler(task);
        results.push(...res);
      }),
    ),
  );

  return results;
}
