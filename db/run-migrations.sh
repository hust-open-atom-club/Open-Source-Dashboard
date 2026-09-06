#!/bin/sh

set -eu

for migration in /db-source/migrations/*.sql; do
    if [ ! -f "$migration" ]; then
        continue
    fi

    echo "Applying database migration: $(basename "$migration")"
    psql --set ON_ERROR_STOP=1 --file "$migration"
done
