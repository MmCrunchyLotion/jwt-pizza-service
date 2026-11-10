#!/bin/bash
host=$(jq -r '.host' grafanaConfig.json)

if [ -z "$host" ] || [ "$host" = "null" ]; then
  echo "Missing .host in grafanaConfig.json"; exit 1
fi

# Cleanup background processes on exit (CTRL+C)
trap 'trap - SIGINT SIGTERM; kill 0' SIGINT SIGTERM

echo "Starting traffic simulation on $host..."

# 1. Simulating menu browsing
(while true; do
  status=$(curl -s -o /dev/null -w "%{http_code}" "$host/api/order/menu")
  echo "Requesting menu... $status"
  sleep 3
done) &

# 2. Simulating failed logins
(while true; do
  status=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$host/api/auth" \
    -d '{"email":"bad@jwt.com", "password":"bad"}' \
    -H 'Content-Type: application/json')
  echo "Logging in with invalid credentials... $status"
  sleep 25
done) &

# 3. Simulating a successful purchase
(while true; do
  response=$(curl -s -X PUT "$host/api/auth" \
    -d '{"email":"d@jwt.com", "password":"diner"}' \
    -H 'Content-Type: application/json')
  token=$(echo "$response" | jq -r '.token')

  if [ -n "$token" ] && [ "$token" != "null" ]; then
    echo "Login diner... true"
  else
    echo "Login diner... false"
  fi

  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$host/api/order" \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' \
    -d '{"franchiseId": 1, "storeId":1, "items":[{ "menuId": 1, "description": "Veggie", "price": 0.05 }]}')
  echo "Bought a pizza... $status"
  sleep 20
done) &

# Keep the script running
wait