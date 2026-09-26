function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function parseDateLiteral(value, flagName) {
    if (!value || value.startsWith('--')) {
        throw new Error(`${flagName} requires a value in YYYY-MM-DD format.`);
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`${flagName} must use YYYY-MM-DD format.`);
    }

    const [year, month, day] = value.split('-').map(Number);
    const parsedDate = new Date(year, month - 1, day);

    if (formatDate(parsedDate) !== value) {
        throw new Error(`${flagName} is not a valid calendar date.`);
    }

    return parsedDate;
}

function parseBackfillArgs(args) {
    let singleDateArg = null;
    let startDateArg = null;
    let endDateArg = null;
    let flushCache = false;
    let resetExisting = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--help') {
            return { help: true };
        }

        if (arg === '--flush-cache') {
            flushCache = true;
            continue;
        }

        if (arg === '--reset-existing') {
            resetExisting = true;
            continue;
        }

        if (arg === '--date' || arg === '--start-date' || arg === '--end-date') {
            const value = args[i + 1];
            if (!value || value.startsWith('--')) {
                throw new Error(`${arg} requires a value in YYYY-MM-DD format.`);
            }

            if (arg === '--date') {
                singleDateArg = value;
            } else if (arg === '--start-date') {
                startDateArg = value;
            } else {
                endDateArg = value;
            }
            i++;
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    if (singleDateArg && (startDateArg || endDateArg)) {
        throw new Error('Use either --date or --start-date/--end-date, not both.');
    }

    if (!singleDateArg && (!startDateArg || !endDateArg)) {
        throw new Error('You must provide either --date or both --start-date and --end-date.');
    }

    const startDate = singleDateArg
        ? parseDateLiteral(singleDateArg, '--date')
        : parseDateLiteral(startDateArg, '--start-date');
    const endDate = singleDateArg
        ? parseDateLiteral(singleDateArg, '--date')
        : parseDateLiteral(endDateArg, '--end-date');

    if (startDate > endDate) {
        throw new Error('--start-date cannot be later than --end-date.');
    }

    return {
        help: false,
        startDate,
        endDate,
        flushCache,
        resetExisting,
    };
}

module.exports = {
    parseBackfillArgs,
    parseDateLiteral,
};
