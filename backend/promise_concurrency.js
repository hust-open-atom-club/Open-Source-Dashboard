/**
 * Runs promise-returning tasks with limited concurrency.
 *
 * Every queued task is allowed to finish, but any failures are reported to the
 * caller so ingestion cannot continue to aggregation with incomplete data.
 */
async function runPromisesWithConcurrency(tasks, concurrency) {
    const results = [];
    const failures = [];
    let currentIndex = 0;

    const worker = async () => {
        while (currentIndex < tasks.length) {
            const taskIndex = currentIndex++;
            const task = tasks[taskIndex];
            try {
                results[taskIndex] = await task();
            } catch (error) {
                results[taskIndex] = error;
                failures.push(error);
                console.error(`Task at index ${taskIndex} failed:`, error.message);
            }
        }
    };

    const workers = Array(concurrency).fill(null).map(() => worker());
    await Promise.all(workers);

    if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} task(s) failed.`);
    }

    return results;
}

module.exports = {
    runPromisesWithConcurrency,
};
