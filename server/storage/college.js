export async function getCollegeFile(resource) {
  return {
    type: "college",
    url: resource.url,
  };
}

export async function downloadCollegeFile(resource) {
  console.log(
    `[${resource.id}] Downloading ${resource.name}`
  );

  const response = await fetch(resource.url);

  if (response.status === 404) {
    const error = new Error(
      `College server returned 404`
    );

    error.code = "COLLEGE_FILE_NOT_FOUND";
    error.status = 404;

    throw error;
  }

  if (!response.ok) {
    const error = new Error(
      `College server returned ${response.status}`
    );

    error.code = "COLLEGE_HTTP_ERROR";
    error.status = response.status;

    throw error;
  }

  return Buffer.from(
    await response.arrayBuffer()
  );
}